import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import {
  AuditCategory,
  ParticipantStatus,
  Role,
  TournamentStatus,
} from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { AuditService } from '../audit/audit.service';
import { AuthService, isUnroutableAddress } from './auth.service';
import { GoogleAuthService } from './google-auth.service';
import { TwoFactorService } from './two-factor.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import {
  AccountProofDto,
  ChangeEmailDto,
  ChangePasswordDto,
  DeleteAccountDto,
} from './dto/auth.dto';

/** How a sensitive change is confirmed. `code`: an emailed code, used whenever
 *  this site can send mail (the user's rule, 2026-09-16). `password`: the
 *  current password, when it cannot. `google`: signing in with Google again —
 *  the only proof a Google-only account on a mail-less site can give, and what
 *  lets it set a password and become an ordinary account. `none`: nothing is
 *  available, so the change is refused. */
export type ProofMethod = 'code' | 'password' | 'google' | 'none';

/** `iat` in a token is whole seconds, so a revocation stamp has to land on a
 *  second boundary to be unambiguous.
 *  - `thisSecond` — everything issued BEFORE this second is void; a token
 *    minted within it survives. That is the replacement session a password
 *    change hands back to the browser making the change.
 *  - `nextSecond` — everything issued up to and including this second is void,
 *    which is what "sign out everywhere, this browser too" means. */
const thisSecond = () => new Date(Math.floor(Date.now() / 1000) * 1000);
const nextSecond = () => new Date((Math.floor(Date.now() / 1000) + 1) * 1000);

/** Wrong current-password guesses allowed per window. The emailed code has its
 *  own five-attempt budget; the password had none, and it guards the same
 *  changes. */
const PASSWORD_TRIES = 5;
const PASSWORD_WINDOW_MS = 15 * 60 * 1000;

/** "c••••@example.com" — enough to recognise your own address on screen
 *  without printing it in full on a shared display. */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [name, domain] = email.split('@');
  if (!domain) return email;
  return `${name.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(6, name.length - 1)))}@${domain}`;
}

/**
 * A signed-in person changing their own account: password, email, recovery
 * codes, remembered devices, deletion. Everything that could hand the account
 * to somebody else asks for proof first — a session alone is what a phone left
 * unlocked at a venue gives away.
 */
@Injectable()
export class AccountService {
  /** userId → recent wrong current-password attempts. In memory on purpose,
   *  like the 2FA enforcement override: a restart resetting it costs nothing. */
  private readonly passwordMisses = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly twoFactor: TwoFactorService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly google: GoogleAuthService,
  ) {}

  private async load(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.isGuest) throw new NotFoundException('Account not found');
    return user;
  }

  async proofMethod(user: {
    email: string | null;
    hashedPassword: string | null;
    googleId?: string | null;
  }): Promise<ProofMethod> {
    if (user.email && (await this.mail.isConfigured())) return 'code';
    if (user.hashedPassword) return 'password';
    if (user.googleId) return 'google';
    return 'none';
  }

  /** Everything the Settings page shows about signing in, in one read. */
  async security(userId: string, deviceToken?: string) {
    const user = await this.load(userId);
    const [proof, mode, requiredForYou, devices] = await Promise.all([
      this.proofMethod(user),
      this.twoFactor.enforcementMode(),
      this.twoFactor.isRequiredFor(user),
      this.twoFactor.listDevices(userId, deviceToken),
    ]);
    return {
      email: user.email,
      maskedEmail: maskEmail(user.email),
      emailVerified: user.emailVerified,
      hasPassword: !!user.hashedPassword,
      googleLinked: !!user.googleId,
      proof,
      /** Google is accepted as proof whenever it is connected, whatever the
       *  primary method is — useful when the inbox is unreachable. */
      canUseGoogle: !!user.googleId,
      twoFactor: { mode, requiredForYou },
      recoveryCodesLeft: user.twoFactorRecoveryCodes.length,
      devices,
    };
  }

  /** Email a confirmation code to the address on file. Only offered when the
   *  proof IS the code; otherwise it would be a way to spam an inbox. */
  async sendCode(userId: string) {
    const user = await this.load(userId);
    if ((await this.proofMethod(user)) !== 'code') {
      throw new BadRequestException({
        code: 'CODE_NOT_USED',
        message:
          'This site confirms changes with your current password, not an emailed code.',
      });
    }
    const issued = await this.twoFactor.issueCode(user, 'change');
    return { ...issued, to: maskEmail(user.email) };
  }

  /** Throws unless the request carries the proof this account needs. */
  private async assertProof(
    user: {
      id: string;
      email: string | null;
      hashedPassword: string | null;
      googleId?: string | null;
    },
    dto: AccountProofDto,
  ): Promise<void> {
    // Signing in with Google again proves it, for an account that Google knows.
    // Offered whatever else is available: an inbox can be unreachable.
    if (dto.googleCredential) {
      if (!user.googleId) {
        throw new BadRequestException({
          code: 'GOOGLE_NOT_LINKED',
          message: 'This account is not connected to Google.',
        });
      }
      const identity = await this.google.identify(dto.googleCredential);
      if (identity.sub !== user.googleId) {
        throw new BadRequestException({
          code: 'GOOGLE_MISMATCH',
          message:
            'That is a different Google account from the one connected here.',
        });
      }
      return;
    }

    const method = await this.proofMethod(user);

    if (method === 'code') {
      if (!dto.code) {
        throw new BadRequestException({
          code: 'CODE_REQUIRED',
          message: 'Enter the code we emailed you.',
        });
      }
      const check = await this.twoFactor.checkCode(user.id, dto.code);
      if (!check.ok) {
        throw new BadRequestException({
          code: 'CODE_INVALID',
          message: this.auth.codeFailureMessage(check.reason),
        });
      }
      return;
    }

    if (method === 'password') {
      const now = Date.now();
      const recent = (this.passwordMisses.get(user.id) ?? []).filter(
        (t) => now - t < PASSWORD_WINDOW_MS,
      );
      if (recent.length >= PASSWORD_TRIES) {
        const waitMin = Math.ceil(
          (PASSWORD_WINDOW_MS - (now - recent[0])) / 60000,
        );
        throw new HttpException(
          {
            code: 'TOO_MANY_TRIES',
            message: `Too many wrong passwords. Try again in ${waitMin} minute${waitMin === 1 ? '' : 's'}.`,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (
        !dto.currentPassword ||
        !(await bcrypt.compare(dto.currentPassword, user.hashedPassword!))
      ) {
        this.passwordMisses.set(user.id, [...recent, now]);
        throw new BadRequestException({
          code: 'WRONG_PASSWORD',
          message: 'Your current password is not right.',
        });
      }
      this.passwordMisses.delete(user.id);
      return;
    }

    if (method === 'google') {
      throw new BadRequestException({
        code: 'GOOGLE_REQUIRED',
        message: 'Confirm with Google to make this change.',
      });
    }

    throw new BadRequestException({
      code: 'NO_PROOF_AVAILABLE',
      message:
        'This account has no password and this site cannot send email, so the change cannot be confirmed. Ask an admin.',
    });
  }

  /**
   * End every session on the account — this browser included. The stamp is
   * what `JwtAuthGuard` checks, so tokens already handed out stop working
   * (within the guard's 30-second cache; instantly in this process).
   */
  async signOutEverywhere(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { sessionsValidFrom: nextSecond() },
    });
    JwtAuthGuard.forget(userId);
    const devices = await this.twoFactor.revokeDevices(userId);
    return { ok: true, devicesForgotten: devices };
  }

  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
    deviceToken?: string,
  ) {
    const user = await this.load(userId);
    await this.assertProof(user, dto);
    if (
      user.hashedPassword &&
      (await bcrypt.compare(dto.newPassword, user.hashedPassword))
    ) {
      throw new BadRequestException({
        code: 'SAME_PASSWORD',
        message: 'Choose a password you are not already using.',
      });
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        hashedPassword: await this.auth.hashPassword(dto.newPassword),
        // Choosing your own password satisfies a forced change.
        mustChangePassword: false,
        // Everywhere else is signed out: a session someone else is holding must
        // not survive the password that was changed to lock them out. This
        // browser gets a replacement token from the controller, minted within
        // this same second, which is why the stamp is the second's start.
        sessionsValidFrom: thisSecond(),
      },
      select: {
        id: true,
        email: true,
        roles: true,
        username: true,
        avatarUrl: true,
      },
    });
    JwtAuthGuard.forget(userId);
    // Other remembered browsers must pass a code again: if the change is
    // somebody recovering their account, a browser the intruder had would
    // otherwise still skip the second factor. This one is kept.
    const forgotten = await this.twoFactor.revokeDevices(userId, deviceToken);
    return { ok: true, devicesForgotten: forgotten, user: updated };
  }

  async changeEmail(userId: string, dto: ChangeEmailDto) {
    const user = await this.load(userId);
    const email = dto.email.trim().toLowerCase();
    if (email === (user.email ?? '').toLowerCase()) {
      throw new BadRequestException({
        code: 'SAME_EMAIL',
        message: 'That is already your email address.',
      });
    }
    // A site that sends mail sends sign-in codes and resets here; an address
    // that can never receive them would lock the account out.
    if ((await this.mail.isConfigured()) && isUnroutableAddress(email)) {
      throw new BadRequestException({
        code: 'EMAIL_UNROUTABLE',
        message: 'That address cannot receive email. Use a real one.',
      });
    }
    // Checked before the proof, so a taken address does not spend the code.
    const taken = await this.prisma.user.findFirst({
      where: {
        id: { not: userId },
        email: { equals: email, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (taken) {
      throw new BadRequestException({
        code: 'EMAIL_TAKEN',
        message: 'That email is already used by another account.',
      });
    }
    // The code goes to the CURRENT address: proving you can read the inbox the
    // account already trusts is the second factor. The new address is proved
    // at the next sign-in that needs a code (emailVerified is cleared).
    await this.assertProof(user, dto);
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { email, emailVerified: false, emailVerifiedAt: null },
      select: { email: true },
    });
    return { email: updated.email };
  }

  async newRecoveryCodes(userId: string, dto: AccountProofDto) {
    const user = await this.load(userId);
    await this.assertProof(user, dto);
    // Replaces the old set: anything written down before stops working.
    const codes = await this.twoFactor.generateRecoveryCodes(userId);
    return { codes };
  }

  async forgetDevice(userId: string, deviceId: string) {
    // No proof: forgetting a device only ever takes access away.
    if (!(await this.twoFactor.forgetDevice(userId, deviceId))) {
      throw new NotFoundException('That device is not on your account.');
    }
    return { ok: true };
  }

  async deleteSelf(userId: string, dto: DeleteAccountDto) {
    const user = await this.load(userId);
    if (
      dto.confirm.trim().toLowerCase() !== (user.username ?? '').toLowerCase()
    ) {
      throw new BadRequestException({
        code: 'CONFIRM_MISMATCH',
        message: 'Type your username exactly to confirm.',
      });
    }

    // The site must never end up with nobody able to run it.
    if (user.roles.includes(Role.ADMIN)) {
      const otherAdmins = await this.prisma.user.count({
        where: {
          id: { not: userId },
          roles: { has: Role.ADMIN },
          isGuest: false,
        },
      });
      if (otherAdmins === 0) {
        throw new BadRequestException({
          code: 'LAST_ADMIN',
          message:
            'You are the only admin. Make someone else an admin before deleting your account.',
        });
      }
    }

    // Same rule as an admin deletion (F6), worded for the person themselves.
    // Checked before the proof so a refusal does not spend the code.
    const live = await this.prisma.tournamentParticipant.findMany({
      where: {
        userId,
        status: { not: ParticipantStatus.FORFEITED },
        tournament: {
          status: { in: [TournamentStatus.OPEN, TournamentStatus.ONGOING] },
        },
      },
      select: { tournamentId: true, tournament: { select: { name: true } } },
    });
    if (live.length > 0) {
      throw new BadRequestException({
        code: 'ACTIVE_IN_LIVE_TOURNAMENT',
        message: `You are still entered in ${live.length} live tournament${live.length === 1 ? '' : 's'}. Leave, or ask the organizer to withdraw you, then try again.`,
        tournaments: live.map((p) => ({
          id: p.tournamentId,
          name: p.tournament.name,
        })),
      });
    }

    // Format presets used to be deleted with their creator, taking the bracket
    // type of any tournament using them; they are now kept (SetNull) and every
    // started tournament has its own copy, so there is nothing to guard here.
    await this.assertProof(user, dto);
    await this.auth.deleteUser(userId);

    // Written by hand, after the fact: the interceptor would attribute the
    // entry to an account that no longer exists. No actor id — only the name.
    const name = user.displayName || user.username || 'A user';
    await this.audit.record({
      actor: { username: name, roles: user.roles },
      category: AuditCategory.USER,
      action: 'user.delete_self',
      summary: `${name} deleted their own account`,
      targetName: name,
    });
    return { ok: true };
  }
}
