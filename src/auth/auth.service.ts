import { randomUUID } from 'crypto';
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
  GAMES_PLAYED_SELECT,
  flattenGamesPlayed,
} from '../game/games-played.helper';
import {
  AuthDto,
  AdminCreateUserDto,
  ConvertGuestDto,
  SignUpDto,
  BIO_MAX_LENGTH,
  UpdateProfileDto,
  UpdateMeDto,
  VerifyCodeDto,
} from './dto/auth.dto';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { isEmail } from './utils/check-input';
import { Response } from 'express';
import { Role, ParticipantStatus, TournamentStatus } from '@prisma/client';
import { Cron, CronExpression } from '@nestjs/schedule';


/** Trim, cap blank-line runs at one (a bio is a paragraph, not a layout), and
 *  treat an empty result as "no bio". The length rule itself is the DTO's. */
export function normalizeBio(bio: string): string | null {
  const clean = bio.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return clean ? clean.slice(0, BIO_MAX_LENGTH) : null;
}

/** Addresses that exist but can never receive mail: the seed's `.local` default
 *  and IANA's reserved example domains. */
export function isUnroutableAddress(email: string | null): boolean {
  if (!email) return true;
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  return (
    !domain ||
    domain.endsWith('.local') ||
    domain === 'example.com' ||
    domain === 'example.org' ||
    domain === 'example.net'
  );
}

/** Which step of a login a challenge token stands for. */
type ChallengeStep = 'verify' | 'signin' | 'reset';

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

    // With enforcement off, email gates nothing: the account is usable at once.
    // It stays unverified, so if enforcement is switched on later the owner
    // proves the address at their next sign-in (the path just below in SignIn).
    if (!(await this.twoFactor.emailRequired())) {
      return {
        message: 'Account created. You can sign in now.',
        verificationRequired: false,
      };
    }

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
    kind: ChallengeStep,
  ): Promise<string> {
    return this.jwt.signAsync(
      { id: userId, purpose: '2fa', step: kind },
      { expiresIn: kind === 'signin' ? '10m' : '15m' },
    );
  }

  /** Reads a challenge token back, refusing anything that is not one.
   *  `expect` pins the step: a sign-in challenge must not be spendable on a
   *  password reset, which would turn "prove you can read the inbox" into
   *  "change the password" without the code the reset asked for. */
  private async readChallenge(
    challenge: string,
    expect?: ChallengeStep,
  ): Promise<{ id: string; step: ChallengeStep }> {
    try {
      const payload = await this.jwt.verifyAsync<{
        id: string;
        purpose?: string;
        step?: ChallengeStep;
      }>(challenge, { secret: requireJwtSecret() });
      if (payload.purpose !== '2fa' || !payload.id) {
        throw new Error('wrong purpose');
      }
      const step = payload.step ?? 'signin';
      if (expect && step !== expect) throw new Error('wrong step');
      return { id: payload.id, step };
    } catch {
      throw new UnauthorizedException(
        'That sign-in attempt has expired. Please start again.',
      );
    }
  }

  /** Proves a password was just verified, and authorises nothing else. Same
   *  shape as the 2FA challenge above, and rejected by `JwtAuthGuard` for the
   *  same reason: its purpose is not `session`. */
  private async issuePasswordChangeToken(userId: string): Promise<string> {
    return this.jwt.signAsync(
      { id: userId, purpose: 'password_change' },
      { expiresIn: '15m' },
    );
  }

  private async readPasswordChangeToken(token: string): Promise<string> {
    try {
      const payload = await this.jwt.verifyAsync<{
        id: string;
        purpose?: string;
      }>(token, { secret: requireJwtSecret() });
      if (payload.purpose !== 'password_change' || !payload.id) {
        throw new Error('wrong purpose');
      }
      return payload.id;
    } catch {
      throw new UnauthorizedException(
        'That sign-in attempt has expired. Please sign in again.',
      );
    }
  }

  /**
   * Start a password reset.
   *
   * Always answers the same way, whether or not the account exists: an endpoint
   * that says "no such user" is a free membership check for anyone with a list
   * of addresses. The caller is told to check their inbox either way, and only
   * a real account gets a code.
   */
  async requestPasswordReset(identifier: string) {
    const user = await this.prisma.user.findFirst({
      where: isEmail(identifier)
        ? { email: { equals: identifier, mode: 'insensitive' } }
        : { username: { equals: identifier, mode: 'insensitive' } },
    });

    // Guests have no password to reset and no inbox to reset it from.
    const eligible = !!user && !user.isGuest && !!user.email;
    if (eligible) await this.twoFactor.issueCode(user!, 'reset');

    // The RESPONSE SHAPE has to match too, not just the message. Returning a
    // challenge only for real accounts would make the presence of that field a
    // free membership check for anyone with a list of addresses — so an
    // ineligible identifier gets a challenge for an id that does not exist,
    // which simply fails at the code step like a wrong code would.
    return {
      message:
        'If that account exists, a reset code is on its way to its email address.',
      challenge: await this.issueChallenge(
        eligible ? user!.id : randomUUID(),
        'reset',
      ),
    };
  }

  /**
   * Finish a reset with the emailed code.
   *
   * Reuses the same hashed, single-use, five-attempt, throttled code machinery
   * as the second factor — a reset code is a sign-in credential and gets the
   * same treatment.
   */
  async resetPasswordWithCode(
    challenge: string,
    code: string,
    newPassword: string,
    res: Response,
  ) {
    const { id } = await this.readChallenge(challenge, 'reset');
    const check = await this.twoFactor.checkCode(id, code);
    if (!check.ok) {
      throw new BadRequestException(this.codeFailureMessage(check.reason));
    }
    return this.applyNewPassword(id, newPassword, res);
  }

  /**
   * Finish a reset with a recovery code instead.
   *
   * This is the door that survives a dead inbox — the case recovery codes were
   * minted for. The code is spent on use, exactly as it is when skipping the
   * second factor.
   */
  async resetPasswordWithRecovery(
    identifier: string,
    recoveryCode: string,
    newPassword: string,
    res: Response,
  ) {
    const user = await this.prisma.user.findFirst({
      where: isEmail(identifier)
        ? { email: { equals: identifier, mode: 'insensitive' } }
        : { username: { equals: identifier, mode: 'insensitive' } },
    });
    const accepted =
      user && !user.isGuest
        ? await this.twoFactor.useRecoveryCode(user.id, recoveryCode)
        : false;
    if (!user || !accepted) {
      throw new BadRequestException('That recovery code is not valid.');
    }
    return this.applyNewPassword(user.id, newPassword, res);
  }

  /** Shared tail of both reset paths. */
  private async applyNewPassword(
    userId: string,
    newPassword: string,
    res: Response,
  ) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        hashedPassword: await this.hashPassword(newPassword),
        // A reset satisfies a forced change: the password is now one they chose.
        mustChangePassword: false,
      },
    });
    // Every trusted device is revoked. If the reset was somebody else recovering
    // a hijacked account, a remembered browser would otherwise still be inside.
    await this.twoFactor.revokeDevices(userId);
    return this.completeSignIn(user, res);
  }

  /**
   * Replace a password that was set for you, and get the session you were
   * denied.
   *
   * The old password is not asked for again — it was proved moments ago to get
   * this token, and asking twice for a password the holder may have been handed
   * on a slip of paper helps nobody. What IS refused is setting it back to the
   * same value, which would make the whole exercise theatre.
   */
  async changeForcedPassword(
    changeToken: string,
    newPassword: string,
    res: Response,
    email?: string,
  ) {
    const userId = await this.readPasswordChangeToken(changeToken);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('Account no longer exists');

    // The seeded admin is born with `admin@joust.local`, an address that cannot
    // receive anything — so switching two-factor on sends the only ADMIN
    // account's codes into a void, and a seeded account has no recovery codes
    // either. This screen is the one step such an account cannot skip, so it is
    // where the address gets fixed.
    const needsAddress = isUnroutableAddress(user.email);
    if (needsAddress) {
      if (!email || !isEmail(email)) {
        throw new BadRequestException({
          message:
            'This account has no working email address. Enter one you can receive mail at.',
          code: 'EMAIL_REQUIRED',
        });
      }
      const taken = await this.prisma.user.findFirst({
        where: { id: { not: userId }, email: { equals: email, mode: 'insensitive' } },
      });
      if (taken) {
        throw new BadRequestException('That email address is already in use.');
      }
    }

    if (
      user.hashedPassword &&
      (await this.verifyPassword(newPassword, user.hashedPassword))
    ) {
      throw new BadRequestException(
        'Choose a password different from the one you were given.',
      );
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        hashedPassword: await this.hashPassword(newPassword),
        mustChangePassword: false,
        // A new address is unproven until a code reaches it, so it is stored
        // unverified: the next sign-in under `staff`/`all` enforcement asks for
        // that code, and THAT is where recovery codes finally get minted.
        ...(needsAddress && email
          ? { email: email.trim().toLowerCase(), emailVerified: false, emailVerifiedAt: null }
          : {}),
      },
    });

    return this.completeSignIn(updated, res);
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
      // Created through Google sign-in and never given a password. Saying so
      // beats "Invalid credentials", which reads as a wrong password.
      throw new UnauthorizedException(
        foundUser.googleId
          ? 'This account signs in with Google. Use "Sign in with Google", or set a password from Edit Profile.'
          : 'Invalid credentials',
      );
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

    if (
      !foundUser.emailVerified &&
      !foundUser.isGuest &&
      (await this.twoFactor.emailRequired())
    ) {
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

  /** A session for an identity proved some other way — Google sign-in, which
   *  has already done its own second-factor check. Goes through the same
   *  completeSignIn as every other path so the cookie is identical. */
  async startSession(
    user: {
      id: string;
      email: string | null;
      roles: Role[];
      username: string | null;
      avatarUrl: string | null;
    },
    res: Response,
  ) {
    return this.completeSignIn(user, res);
  }

  /** Issues the real session token and cookie. The single place a session is
   *  minted, so every path — password-only, post-2FA, recovery code, Google —
   *  sets the cookie identically. */
  /** A replacement session for THIS browser, after its own sessions were voided
   *  (a password change). Sets the cookie and returns the token, so the caller
   *  is not signed out by its own security action. */
  async reissueSession(
    user: { id: string; email: string | null; roles: Role[]; username: string | null; avatarUrl: string | null },
    res: Response,
  ): Promise<string> {
    const token = await this.generateToken(user.id, user.email, user.roles, user.username, user.avatarUrl);
    res.cookie('token', token, sessionCookieOptions(sessionLifetimeMs()));
    return token;
  }

  private async completeSignIn(
    user: {
      id: string;
      email: string | null;
      roles: Role[];
      username: string | null;
      avatarUrl: string | null;
      mustChangePassword?: boolean;
    },
    res: Response,
  ) {
    // A password somebody else chose buys you one thing: the right to replace
    // it. The diversion lives HERE rather than in SignIn so that every path —
    // password-only, post-2FA, recovery code — is covered by construction; a
    // future sign-in route cannot forget it. Google is exempt in practice, since
    // an account created through Google has no password to be forced to change.
    if (user.mustChangePassword) {
      return {
        passwordChangeRequired: true,
        changeToken: await this.issuePasswordChangeToken(user.id),
        message: 'Choose a new password to finish signing in.',
      };
    }

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

  codeFailureMessage(reason: string): string {
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

  /**
   * A user editing their own profile: username, display name, bio. Password
   * and email are NOT accepted here any more (UpdateMeDto) — they changed with
   * nothing but a session, so a signed-in device left open was enough to take
   * the account. They now go through AccountService, which asks for proof.
   */
  async updateMe(userId: string, dto: UpdateMeDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const renaming = !!dto.username && dto.username !== user.username;
    if (renaming) {
      const conflict = await this.prisma.user.findFirst({
        where: {
          id: { not: userId },
          username: { equals: dto.username, mode: 'insensitive' },
        },
      });
      if (conflict) {
        throw new BadRequestException('That username is already taken.');
      }
    }

    const data: Record<string, any> = {};
    if (renaming) {
      data.username = dto.username;
      // The profile address follows the name, as it already did for an admin
      // rename. A self-rename used to keep the old address. Old UUID links
      // still resolve; the old handle link does not.
      data.slug = await generateUniqueUserSlug(this.prisma, dto.username!, userId);
    }
    // displayName was accepted by the DTO but silently dropped here; the admin
    // path (updateProfile) always saved it. Same rule in both now.
    if (dto.displayName !== undefined) data.displayName = dto.displayName.trim() || null;
    if (dto.bio !== undefined) data.bio = normalizeBio(dto.bio);

    if (dto.gameIds !== undefined) {
      // A guest has no profile to show this on and no session that outlives the
      // tournament, so the list would be written and then deleted with them.
      if (user.isGuest) {
        throw new BadRequestException('Guest accounts cannot list games.');
      }
      // The catalog can change between the page loading and the save, so an id
      // that names nothing is dropped rather than refused. The retired "General"
      // placeholder is never listable for the same reason it is not assignable.
      const known = await this.prisma.game.findMany({
        where: { id: { in: dto.gameIds }, isBuiltin: false },
        select: { id: true },
      });
      data.games = {
        deleteMany: {},
        create: known.map((g) => ({ gameId: g.id })),
      };
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        username: true,
        displayName: true,
        slug: true,
        bio: true,
        email: true,
        roles: true,
        avatarUrl: true,
        games: GAMES_PLAYED_SELECT,
      },
    });
    return { ...updated, games: flattenGamesPlayed(updated.games) };
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
        bio: true,
        googleId: true,
        hashedPassword: true,
        games: GAMES_PLAYED_SELECT,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    // Reported as facts, never as values: the profile needs to know whether
    // Google is connected and whether disconnecting would leave no way in.
    const { googleId, hashedPassword, ...rest } = user;
    return {
      ...rest,
      games: flattenGamesPlayed(user.games),
      googleLinked: !!googleId,
      hasPassword: !!hashedPassword,
    };
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

    // No slug for guests — see joinTournamentAsGuest.
    return this.prisma.user.create({
      data: {
        isGuest: true,
        username,
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
    if (dto.bio !== undefined) data.bio = normalizeBio(dto.bio); // an admin clearing an abusive bio
    if (email) data.email = email;
    if (dto.password) {
      data.hashedPassword = await this.hashPassword(dto.password);
      // An admin resetting a password is handing over a temporary one — the
      // same situation as account creation, so the same rule. Self-service
      // changes (updateMe) deliberately do not set this.
      data.mustChangePassword = true;
    }

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
        // Whoever this is for did not choose this password, and an admin now
        // knows it. It buys exactly one sign-in, spent on replacing it.
        mustChangePassword: true,
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
