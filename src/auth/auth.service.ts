import {
  requireJwtSecret,
  sessionCookieOptions,
  sessionLifetimeMs,
} from '../config/security.config';
import { TwoFactorService } from './two-factor.service';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { generateUniqueUserSlug } from '../user/user-slug.util';
import {
  AuthDto,
  AdminCreateUserDto,
  ConvertGuestDto,
  SignUpDto,
  UpdateProfileDto,
  VerifyCodeDto,
} from './dto/auth.dto';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { isEmail } from './utils/check-input';
import { Response } from 'express';
import { Role, ParticipantStatus, TournamentStatus } from '@prisma/client';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private twoFactor: TwoFactorService,
  ) {}

  // Scheduled guest cleanup used to live here as two crons (midnight + hourly),
  // duplicating two more in jobs/cleanGuests.ts. All four were consolidated into
  // the single hourly CleanGuestsJob, which calls deleteUser() below for the
  // stale-guest phase so name-burning still happens.

  // ──────────────────────────────────────────────
  // PURGE EXPIRED GUESTS (Triggered by Admin/Organizer actions)
  // ──────────────────────────────────────────────
  async purgeExpiredGuests() {
    const now = new Date();
    const expired = await this.prisma.user.findMany({
      where: {
        isGuest: true,
        OR: [{ isExpired: true }, { expiresAt: { lt: now } }],
      },
      select: { id: true },
    });

    for (const user of expired) {
      try {
        await this.deleteUser(user.id);
      } catch (err) {
        // Silently skip if already gone or locked
      }
    }
  }

  // ──────────────────────────────────────────────
  // SIGN UP
  // ──────────────────────────────────────────────
  /**
   * Register, then prove the address.
   *
   * The account is created unverified and CANNOT sign in until the emailed code
   * is confirmed — verification is part of registering, not a later nag. The
   * caller gets a short-lived challenge token to submit that code with.
   *
   * This used to accept a bare username and invent `user_<name>@example.com`
   * for it. That domain is IANA-reserved and cannot receive mail, so such an
   * account could never verify and, under the current rules, could never log in.
   */
  async SignUp(dto: SignUpDto) {
    const { identifier: username, password } = dto;
    // Emails are stored lowercased so the address is canonical: domains are
    // case-insensitive by RFC and Gmail ignores case entirely, so two casings
    // are one inbox — and with email as the second factor they must not be two
    // accounts.
    const email = dto.email.trim().toLowerCase();
    const displayName = dto.displayName?.trim() || null;

    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: { equals: email, mode: 'insensitive' } },
          { username: { equals: username, mode: 'insensitive' } },
        ],
      },
    });
    if (existingUser) {
      throw new BadRequestException('User already exists');
    }

    const hashedPassword = await this.hashPassword(password);
    const slug = await generateUniqueUserSlug(this.prisma, username);
    const user = await this.prisma.user.create({
      data: {
        email,
        username,
        displayName,
        slug,
        hashedPassword,
        roles: [Role.PLAYER],
        emailVerified: false,
      },
    });

    const issued = await this.twoFactor.issueCode(user, 'verify');
    return {
      message: 'Check your email for a verification code.',
      verificationRequired: true,
      challenge: await this.issueChallenge(user.id, 'verify'),
      // A delivery failure must be visible: the account exists but is unusable
      // until verified, so silence here would look like a broken signup.
      emailSent: issued.sent,
      ...(issued.error ? { emailError: issued.error } : {}),
    };
  }

  /** A short-lived token that proves one step has been passed and nothing more.
   *  `JwtAuthGuard` rejects every purpose except `session`. */
  private async issueChallenge(
    userId: string,
    kind: 'verify' | 'signin',
  ): Promise<string> {
    return this.jwt.signAsync(
      { id: userId, purpose: '2fa', step: kind },
      { expiresIn: kind === 'verify' ? '15m' : '10m' },
    );
  }

  /** Reads a challenge token back, refusing anything that is not one. */
  private async readChallenge(
    challenge: string,
  ): Promise<{ id: string; step: 'verify' | 'signin' }> {
    try {
      const payload = await this.jwt.verifyAsync<{
        id: string;
        purpose?: string;
        step?: 'verify' | 'signin';
      }>(challenge, { secret: requireJwtSecret() });
      if (payload.purpose !== '2fa' || !payload.id) {
        throw new Error('wrong purpose');
      }
      return { id: payload.id, step: payload.step ?? 'signin' };
    } catch {
      throw new UnauthorizedException(
        'That sign-in attempt has expired. Please start again.',
      );
    }
  }

  // ──────────────────────────────────────────────
  // SIGN IN
  // ──────────────────────────────────────────────
  async SignIn(dto: AuthDto, res: Response, deviceToken?: string) {
    const { identifier, password } = dto;

    const isEmailUser = isEmail(identifier);

    // Case-insensitive: typing "Paul" when you registered "paul" used to fail
    // with "User is not Registered", which reads as though the account is gone.
    // Uniqueness is enforced case-insensitively by a functional index, so this
    // can still match at most one row.
    const foundUser = await this.prisma.user.findFirst({
      where: isEmailUser
        ? { email: { equals: identifier, mode: 'insensitive' } }
        : { username: { equals: identifier, mode: 'insensitive' } },
    });

    if (!foundUser) {
      throw new BadRequestException('User is not Registered');
    }

    if (!foundUser.hashedPassword) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await this.verifyPassword(
      password,
      foundUser.hashedPassword,
    );
    if (!isPasswordValid) {
      throw new BadRequestException('Incorrect Password');
    }

    // ── Second factor ──────────────────────────────────────────────────
    // The password was right; that is one factor. Everything below decides
    // whether a session is issued now or only after a code is proved.

    if (!foundUser.emailVerified && !foundUser.isGuest) {
      // Registration was abandoned before the address was proved. Same code
      // machinery, different wording — the account is unusable until verified.
      const issued = await this.twoFactor.issueCode(foundUser, 'verify');
      return {
        verificationRequired: true,
        challenge: await this.issueChallenge(foundUser.id, 'verify'),
        emailSent: issued.sent,
        ...(issued.error ? { emailError: issued.error } : {}),
        message: 'Verify your email address to finish signing in.',
      };
    }

    const required = await this.twoFactor.isRequiredFor({
      roles: foundUser.roles,
      isGuest: foundUser.isGuest,
    });
    const trusted =
      required &&
      (await this.twoFactor.isTrustedDevice(foundUser.id, deviceToken));

    if (required && !trusted) {
      const issued = await this.twoFactor.issueCode(foundUser, 'signin');
      return {
        twoFactorRequired: true,
        challenge: await this.issueChallenge(foundUser.id, 'signin'),
        emailSent: issued.sent,
        ...(issued.error ? { emailError: issued.error } : {}),
        ...(issued.retryAfterSeconds
          ? { retryAfterSeconds: issued.retryAfterSeconds }
          : {}),
        message: 'We emailed you a sign-in code.',
      };
    }

    return this.completeSignIn(foundUser, res);
  }

  /** Issues the real session token and cookie. The single place a session is
   *  minted, so every path — password-only, post-2FA, recovery code — sets the
   *  cookie identically. */
  private async completeSignIn(
    user: {
      id: string;
      email: string | null;
      roles: Role[];
      username: string | null;
      avatarUrl: string | null;
    },
    res: Response,
  ) {
    const token = await this.generateToken(
      user.id,
      user.email,
      user.roles,
      user.username,
      user.avatarUrl,
    );

    // `secure` is env-driven (7.6): hardcoding false shipped the session cookie
    // over plain http in production. sameSite stays 'lax' — it is what stops a
    // cross-site socket handshake carrying this cookie (see realtime.gateway).
    res.cookie('token', token, sessionCookieOptions(sessionLifetimeMs()));

    return {
      message: 'You have Signed In successfully',
      roles: user.roles,
      token,
    };
  }

  /**
   * Finish a sign-in or a registration by submitting the emailed code.
   *
   * On success for a `verify` challenge the address is marked proved and
   * recovery codes are minted — that is the one moment they can be shown, since
   * there is no separate enrolment step to hang them off.
   */
  async submitCode(
    dto: VerifyCodeDto,
    res: Response,
    userAgent?: string,
  ): Promise<Record<string, unknown>> {
    const { id, step } = await this.readChallenge(dto.challenge);

    const check = await this.twoFactor.checkCode(id, dto.code);
    if (!check.ok) {
      throw new BadRequestException(this.codeFailureMessage(check.reason));
    }

    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new UnauthorizedException('Account no longer exists');

    let recoveryCodes: string[] | undefined;
    if (step === 'verify' || !user.emailVerified) {
      await this.prisma.user.update({
        where: { id },
        data: { emailVerified: true, emailVerifiedAt: new Date() },
      });
      recoveryCodes = await this.twoFactor.generateRecoveryCodes(id);
    }

    if (dto.rememberDevice) {
      await this.setDeviceCookie(id, res, userAgent);
    }

    const session = await this.completeSignIn(user, res);
    return {
      ...session,
      ...(recoveryCodes ? { recoveryCodes } : {}),
    };
  }

  /** Recovery codes exist because email IS the second factor: a dead inbox
   *  would otherwise be an unrecoverable lockout. */
  async submitRecoveryCode(
    challenge: string,
    recoveryCode: string,
    res: Response,
  ) {
    const { id } = await this.readChallenge(challenge);
    const accepted = await this.twoFactor.useRecoveryCode(id, recoveryCode);
    if (!accepted) {
      throw new BadRequestException('That recovery code is not valid.');
    }
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new UnauthorizedException('Account no longer exists');
    // A recovery code proves the address is unreachable, so the account is
    // marked verified rather than left in limbo behind an inbox nobody can read.
    if (!user.emailVerified) {
      await this.prisma.user.update({
        where: { id },
        data: { emailVerified: true, emailVerifiedAt: new Date() },
      });
    }
    return this.completeSignIn(user, res);
  }

  async resendCode(challenge: string) {
    const { id, step } = await this.readChallenge(challenge);
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new UnauthorizedException('Account no longer exists');
    const issued = await this.twoFactor.issueCode(user, step);
    if (!issued.sent && issued.retryAfterSeconds) {
      throw new BadRequestException(
        `Please wait ${issued.retryAfterSeconds}s before requesting another code.`,
      );
    }
    return {
      message: issued.sent ? 'Code sent.' : 'Could not send the code.',
      emailSent: issued.sent,
      ...(issued.error ? { emailError: issued.error } : {}),
    };
  }

  private async setDeviceCookie(
    userId: string,
    res: Response,
    userAgent?: string,
  ) {
    const token = await this.twoFactor.trustDevice(userId, userAgent);
    // 30 days, same options as the session cookie so it inherits the
    // secure/sameSite protections rather than being a weaker second cookie.
    res.cookie('device', token, sessionCookieOptions(30 * 24 * 60 * 60 * 1000));
  }

  private codeFailureMessage(reason: string): string {
    if (reason === 'expired')
      return 'That code has expired. Request a new one.';
    if (reason === 'exhausted')
      return 'Too many incorrect attempts. Request a new code.';
    if (reason === 'none') return 'No code is pending. Request a new one.';
    return 'That code is not correct.';
  }

  // ──────────────────────────────────────────────
  // SIGN OUT
  // ──────────────────────────────────────────────
  SignOut(res: Response) {
    res.clearCookie('token');
    return { message: 'You have Signed Out successfully' };
  }

  async updateMe(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (dto.email || dto.username) {
      const conflict = await this.prisma.user.findFirst({
        where: {
          id: { not: userId },
          OR: [
            ...(dto.email ? [{ email: dto.email }] : []),
            ...(dto.username ? [{ username: dto.username }] : []),
          ],
        },
      });
      if (conflict) {
        throw new BadRequestException('Username or email already taken');
      }
    }

    const data: Record<string, any> = {};
    if (dto.username) data.username = dto.username;
    if (dto.email) data.email = dto.email;
    if (dto.password)
      data.hashedPassword = await this.hashPassword(dto.password);

    return this.prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        username: true,
        displayName: true,
        email: true,
        roles: true,
        avatarUrl: true,
      },
    });
  }

  // ──────────────────────────────────────────────
  // HELPERS
  // ──────────────────────────────────────────────
  async hashPassword(password: string) {
    const saltOrRounds = 10;
    return bcrypt.hash(password, saltOrRounds);
  }

  async verifyPassword(password: string, hashedPassword: string) {
    return bcrypt.compare(password, hashedPassword);
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        slug: true,
        email: true,
        roles: true,
        isGuest: true,
        avatarUrl: true,
        createdAt: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /** A full session token. Everything else the login flow issues (a 2FA
   *  challenge, a forced-password-change token) is minted separately and carries
   *  a different `purpose`, which the guards reject. */
  async generateToken(
    userId: string,
    email: string | null,
    roles: Role[],
    username: string | null,
    avatarUrl?: string | null,
  ) {
    const payload = {
      id: userId,
      email,
      roles,
      username,
      avatarUrl,
      purpose: 'session' as const,
    };
    return this.jwt.signAsync(payload);
  }

  // ──────────────────────────────────────────────
  // GET ALL USERS
  // ──────────────────────────────────────────────
  async getAllUsers() {
    await this.purgeExpiredGuests(); // Cleanup before returning list to admin/organizer
    return this.prisma.user.findMany({
      select: {
        id: true,
        username: true,
        displayName: true,
        email: true,
        roles: true,
        isGuest: true,
        expiresAt: true,
        isExpired: true,
      },
    });
  }

  // ──────────────────────────────────────────────
  // GET ONLY REGISTERED USERS (excluding guests)
  // ──────────────────────────────────────────────
  async getRegisteredUsers() {
    return this.prisma.user.findMany({
      where: {
        isGuest: false,
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        email: true,
        roles: true,
      },
    });
  }

  // ──────────────────────────────────────────────
  // UPDATE USER ROLES
  // ──────────────────────────────────────────────
  async updateRoles(userId: string, roles: Role[]) {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        roles,
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        roles: true,
      },
    });
  }

  // ──────────────────────────────────────────────
  // CREATE GUEST USER (for walk-ins)
  // ──────────────────────────────────────────────
  async CreateGuestUser(username: string) {
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24); // 24-hour lifespan by default

    const slug = await generateUniqueUserSlug(this.prisma, username);
    return this.prisma.user.create({
      data: {
        isGuest: true,
        username,
        slug,
        roles: [Role.PLAYER],
        expiresAt,
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        isGuest: true,
        expiresAt: true,
      },
    });
  }

  // ──────────────────────────────────────────────
  // ITEM 1: DELETE USER (Admin) — preserves match history
  // ──────────────────────────────────────────────
  async deleteUser(targetId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetId },
    });
    if (!user) throw new NotFoundException('User not found');

    // F6. Refuse to delete someone still active in a live tournament. Deleting
    // them would null their pending match slots with no walkover, stalling the
    // opponent and the bracket. The organizer must forfeit them first (which
    // awards their pending matches to opponents), then the account can go. A
    // FORFEITED participant is fine — they have already been walked over.
    const liveParticipation = await this.prisma.tournamentParticipant.findMany({
      where: {
        userId: targetId,
        status: { not: ParticipantStatus.FORFEITED },
        tournament: {
          status: {
            in: [TournamentStatus.OPEN, TournamentStatus.ONGOING],
          },
        },
      },
      select: { tournamentId: true, tournament: { select: { name: true } } },
    });
    if (liveParticipation.length > 0) {
      // Structured payload so the admin UI can offer a forfeit-then-delete flow:
      // it lists the live tournaments to forfeit the user from before retrying.
      throw new BadRequestException({
        code: 'ACTIVE_IN_LIVE_TOURNAMENT',
        message:
          `This user is an active participant in ${liveParticipation.length} live ` +
          `tournament(s). Forfeit them first, then delete the account.`,
        tournaments: liveParticipation.map((p) => ({
          id: p.tournamentId,
          name: p.tournament.name,
        })),
      });
    }

    const displayName = user.username ?? 'Deleted player';

    // All seven steps run as one transaction. The whole point of the ordering is
    // that steps 1-6 preserve this player's name in finished brackets before
    // step 7 destroys the account it came from. Half-applied, it produces
    // matches showing a name with a null player id while the account still
    // exists - a user who is a ghost in their own match history. Every step is a
    // plain database write, so there is nothing that needs to happen outside.
    await this.prisma.$transaction(async (tx) => {
      // Step 1: Burn name into any match where they were player1
      await tx.match.updateMany({
        where: { player1Id: targetId },
        data: { p1Name: displayName, player1Id: null },
      });

      // Step 2: Burn name into any match where they were player2
      await tx.match.updateMany({
        where: { player2Id: targetId },
        data: { p2Name: displayName, player2Id: null },
      });

      // Step 3: Burn name into any match where they were the winner
      await tx.match.updateMany({
        where: { winnerId: targetId },
        data: { winnerName: displayName, winnerId: null },
      });

      // Step 4: Burn name into any tournament where they were the winner
      await tx.tournament.updateMany({
        where: { winnerId: targetId },
        data: { winnerName: displayName, winnerId: null } as any,
      });

      // Step 5: Handle tournaments they created (if any)
      await tx.tournament.updateMany({
        where: { createdById: targetId },
        data: { createdById: null } as any,
      });

      // Step 6: Remove all tournament participations
      await tx.tournamentParticipant.deleteMany({
        where: { userId: targetId },
      });

      // Step 7: Delete the user
      await tx.user.delete({ where: { id: targetId } });
    });

    return { message: `"${displayName}" has been permanently removed.` };
  }

  // ──────────────────────────────────────────────
  // ITEM 2: CONVERT GUEST TO A REGISTERED ACCOUNT
  // ──────────────────────────────────────────────
  async convertGuest(guestId: string, dto: ConvertGuestDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: guestId },
    });
    if (!user) throw new NotFoundException('User not found');
    if (!user.isGuest)
      throw new BadRequestException('User already has a registered account');

    // Check for conflicts
    const conflict = await this.prisma.user.findFirst({
      where: {
        id: { not: guestId },
        OR: [{ email: dto.email }, { username: dto.username }],
      },
    });
    if (conflict) {
      throw new BadRequestException('Username or email already taken');
    }

    const hashedPassword = await this.hashPassword(dto.password);

    const upgraded = await this.prisma.user.update({
      where: { id: guestId },
      data: {
        username: dto.username,
        email: dto.email,
        hashedPassword,
        isGuest: false,
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        email: true,
        roles: true,
      },
    });

    return {
      message: 'Guest successfully converted to a registered account',
      user: upgraded,
    };
  }

  // ──────────────────────────────────────────────
  // ITEM 4: ADMIN — UPDATE USER PROFILE
  // ──────────────────────────────────────────────
  async updateProfile(targetId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!user) throw new NotFoundException('User not found');

    // Conflicts are checked case-insensitively, matching the functional unique
    // indexes — otherwise this would wave through a rename the database then
    // rejects with a raw constraint error.
    const email = dto.email?.trim().toLowerCase();
    if (email || dto.username) {
      const conflict = await this.prisma.user.findFirst({
        where: {
          id: { not: targetId },
          OR: [
            ...(email
              ? [{ email: { equals: email, mode: 'insensitive' as const } }]
              : []),
            ...(dto.username
              ? [
                  {
                    username: {
                      equals: dto.username,
                      mode: 'insensitive' as const,
                    },
                  },
                ]
              : []),
          ],
        },
      });
      if (conflict) {
        throw new BadRequestException('Username or email already taken');
      }
    }

    const data: Record<string, unknown> = {};
    if (dto.username) data.username = dto.username;
    if (dto.displayName !== undefined) {
      // Empty string clears it, falling back to showing the handle.
      data.displayName = dto.displayName.trim() || null;
    }
    if (email) data.email = email;
    if (dto.password)
      data.hashedPassword = await this.hashPassword(dto.password);

    // Re-derive the profile handle when the username actually changes. Old links
    // still resolve via the UUID path, so a rename never 404s a shared link — it
    // just makes the pretty handle match the new name.
    if (dto.username && dto.username !== user.username) {
      data.slug = await generateUniqueUserSlug(
        this.prisma,
        dto.username,
        targetId,
      );
    }

    const updated = await this.prisma.user.update({
      where: { id: targetId },
      data,
      select: {
        id: true,
        username: true,
        displayName: true,
        email: true,
        roles: true,
        slug: true,
      },
    });

    return { message: 'Profile updated', user: updated };
  }

  // ──────────────────────────────────────────────
  // ITEM 4: ADMIN — CREATE USER MANUALLY
  // ──────────────────────────────────────────────
  async adminCreateUser(dto: AdminCreateUserDto) {
    const conflict = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: dto.email }, { username: dto.username }],
      },
    });
    if (conflict)
      throw new BadRequestException('Username or email already exists');

    const hashedPassword = await this.hashPassword(dto.password);

    const slug = await generateUniqueUserSlug(this.prisma, dto.username);
    const created = await this.prisma.user.create({
      data: {
        username: dto.username,
        email: dto.email,
        slug,
        hashedPassword,
        roles: dto.roles && dto.roles.length > 0 ? dto.roles : [Role.PLAYER],
        isGuest: false,
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        email: true,
        roles: true,
      },
    });

    return { message: 'Account created', user: created };
  }
}
