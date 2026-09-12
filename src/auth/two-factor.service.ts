import { Injectable, Logger } from '@nestjs/common';
import { randomInt, randomBytes, createHash } from 'crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from 'prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { SettingsService } from '../settings/settings.service';
import { twoFactorEmail, verificationEmail } from '../mail/templates';

/** Codes are short-lived on purpose; an inbox is not a vault. */
const SIGNIN_CODE_TTL_MS = 10 * 60 * 1000;
const VERIFY_CODE_TTL_MS = 15 * 60 * 1000;
/** A 6-digit code is a million guesses. Unlimited attempts turns that into
 *  minutes of scripted work, so the code dies after five. */
const MAX_ATTEMPTS = 5;
/** One code per minute, per user — stops the endpoint being used to spam
 *  somebody's inbox, and protects the daily send quota. */
const RESEND_THROTTLE_MS = 60 * 1000;
const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type CodeKind = 'signin' | 'verify';

export interface CodeIssue {
  sent: boolean;
  /** Present only when mail could not be delivered, so the caller can say so. */
  error?: string;
  /** Seconds until another code may be requested. */
  retryAfterSeconds?: number;
}

export type CodeCheck =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'invalid' | 'exhausted' | 'none' };

@Injectable()
export class TwoFactorService {
  private readonly logger = new Logger(TwoFactorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly settings: SettingsService,
  ) {}

  // ─── Codes ──────────────────────────────────────────────────────────────

  private generateCode(): string {
    // randomInt, not Math.random: this is a credential.
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  /**
   * Issue a fresh code and email it. Any unconsumed code for this user is
   * invalidated first — otherwise "resend" leaves several live codes, which
   * multiplies the guessing surface for no benefit.
   */
  async issueCode(
    user: { id: string; email: string | null },
    kind: CodeKind,
  ): Promise<CodeIssue> {
    if (!user.email) {
      return {
        sent: false,
        error: 'This account has no email address on file.',
      };
    }

    // Throttle on the last code ISSUED, not the last one still live. Scoping it
    // to unconsumed codes meant five wrong guesses burned the code and a fresh
    // one could be had instantly — burn-and-retry, five guesses per email, with
    // no delay between rounds. It also let the endpoint be used to flood an
    // inbox by simply failing each code.
    const latest = await this.prisma.twoFactorCode.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    // ...but a code that was entered CORRECTLY does not count. Signing out and
    // back in within the minute is an ordinary thing to do, and throttling it
    // left the account in a dead end: the new challenge has no pending code, so
    // the code screen says "No code is pending. Request a new one." and the
    // resend that would fix it is throttled too. A success already required
    // reading the inbox, so exempting it floods nothing.
    if (latest && !latest.succeededAt) {
      const age = Date.now() - latest.createdAt.getTime();
      if (age < RESEND_THROTTLE_MS) {
        return {
          sent: false,
          retryAfterSeconds: Math.ceil((RESEND_THROTTLE_MS - age) / 1000),
        };
      }
    }

    const code = this.generateCode();
    const ttl = kind === 'verify' ? VERIFY_CODE_TTL_MS : SIGNIN_CODE_TTL_MS;

    await this.prisma.$transaction([
      this.prisma.twoFactorCode.updateMany({
        where: { userId: user.id, consumedAt: null },
        data: { consumedAt: new Date() },
      }),
      this.prisma.twoFactorCode.create({
        data: {
          userId: user.id,
          codeHash: await bcrypt.hash(code, 10),
          expiresAt: new Date(Date.now() + ttl),
        },
      }),
    ]);

    const template =
      kind === 'verify' ? verificationEmail(code) : twoFactorEmail(code);
    const result = await this.mail.send({ to: user.email, ...template });
    if (!result.delivered) {
      return {
        sent: false,
        error: result.error ?? 'Could not send the email.',
      };
    }
    return { sent: true };
  }

  /**
   * Check a submitted code. Attempts are counted against the stored row, so a
   * caller cannot reset the budget by asking again — only by triggering a new
   * code, which is itself throttled.
   */
  async checkCode(userId: string, code: string): Promise<CodeCheck> {
    const row = await this.prisma.twoFactorCode.findFirst({
      where: { userId, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) return { ok: false, reason: 'none' };

    if (row.expiresAt.getTime() < Date.now()) {
      await this.prisma.twoFactorCode.update({
        where: { id: row.id },
        data: { consumedAt: new Date() },
      });
      return { ok: false, reason: 'expired' };
    }

    if (row.attempts >= MAX_ATTEMPTS) {
      await this.prisma.twoFactorCode.update({
        where: { id: row.id },
        data: { consumedAt: new Date() },
      });
      return { ok: false, reason: 'exhausted' };
    }

    if (await bcrypt.compare(code, row.codeHash)) {
      const now = new Date();
      await this.prisma.twoFactorCode.update({
        where: { id: row.id },
        data: { consumedAt: now, succeededAt: now },
      });
      return { ok: true };
    }

    const attempts = row.attempts + 1;
    await this.prisma.twoFactorCode.update({
      where: { id: row.id },
      data: {
        attempts,
        // Burn it on the last failure rather than leaving a dead row that keeps
        // reporting "invalid" — the user needs to be told to request a new one.
        ...(attempts >= MAX_ATTEMPTS ? { consumedAt: new Date() } : {}),
      },
    });
    return {
      ok: false,
      reason: attempts >= MAX_ATTEMPTS ? 'exhausted' : 'invalid',
    };
  }

  // ─── Recovery codes ─────────────────────────────────────────────────────

  /** Ten one-time codes, returned in plaintext ONCE and stored hashed. Email is
   *  the second factor here, so these are the only way back in when an inbox
   *  dies without involving an admin. */
  async generateRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: 10 }, () =>
      randomBytes(5)
        .toString('hex')
        .toUpperCase()
        .match(/.{1,5}/g)!
        .join('-'),
    );
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorRecoveryCodes: await Promise.all(
          codes.map((c) => bcrypt.hash(c, 10)),
        ),
      },
    });
    return codes;
  }

  /** Consumes the matching recovery code if there is one. */
  async useRecoveryCode(userId: string, submitted: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { twoFactorRecoveryCodes: true },
    });
    const hashes = user?.twoFactorRecoveryCodes ?? [];
    const normalised = submitted.trim().toUpperCase();

    for (const hash of hashes) {
      if (await bcrypt.compare(normalised, hash)) {
        await this.prisma.user.update({
          where: { id: userId },
          data: { twoFactorRecoveryCodes: hashes.filter((h) => h !== hash) },
        });
        this.logger.warn(`Recovery code used for user ${userId}`);
        return true;
      }
    }
    return false;
  }

  // ─── Trusted devices ────────────────────────────────────────────────────

  /** SHA-256 rather than bcrypt: this is a 32-byte random token, not a guessable
   *  secret, and it is checked on every request-ish path where speed matters. */
  private hashDeviceToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async trustDevice(userId: string, userAgent?: string): Promise<string> {
    const token = randomBytes(32).toString('hex');
    await this.prisma.trustedDevice.create({
      data: {
        userId,
        tokenHash: this.hashDeviceToken(token),
        userAgent: userAgent?.slice(0, 255),
        expiresAt: new Date(Date.now() + DEVICE_TTL_MS),
      },
    });
    return token;
  }

  /** True when this browser has already passed the second factor for this user
   *  and the trust has not expired. Touches lastUsedAt so the device list is
   *  useful for spotting something you do not recognise. */
  async isTrustedDevice(userId: string, token?: string): Promise<boolean> {
    if (!token) return false;
    const row = await this.prisma.trustedDevice.findUnique({
      where: { tokenHash: this.hashDeviceToken(token) },
    });
    // Bound to the user: a cookie minted for one account must not skip the
    // challenge for another.
    if (!row || row.userId !== userId) return false;
    if (row.expiresAt.getTime() < Date.now()) {
      await this.prisma.trustedDevice
        .delete({ where: { id: row.id } })
        .catch(() => undefined);
      return false;
    }
    await this.prisma.trustedDevice.update({
      where: { id: row.id },
      data: { lastUsedAt: new Date() },
    });
    return true;
  }

  async revokeDevices(userId: string): Promise<number> {
    const { count } = await this.prisma.trustedDevice.deleteMany({
      where: { userId },
    });
    return count;
  }

  // ─── Enforcement ────────────────────────────────────────────────────────

  /** Runtime override set from admin Dev Tools. Deliberately in-memory, like
   *  `TournamentService.GUEST_EXPIRY_DAYS`: a disabled second factor that cannot
   *  survive a restart is far safer than one persisted in a table. */
  static enforcementOverride: string | null = null;

  /**
   * The effective mode. Nothing stored means 'off' (see settings.keys.ts); a
   * stored value that is not a recognised mode still resolves to 'all' — a
   * garbled setting should fail closed, not quietly disable the second factor.
   */
  async enforcementMode(): Promise<'all' | 'staff' | 'off'> {
    const raw =
      TwoFactorService.enforcementOverride ??
      (await this.settings.get('TWO_FACTOR_ENFORCEMENT')) ??
      'off';
    const mode = raw.trim().toLowerCase();
    return mode === 'off' || mode === 'staff' ? mode : 'all';
  }

  /** 'off' means email is not used to gate anything — neither sign-in codes
   *  nor the address check at registration — so a site with no mail works. */
  async emailRequired(): Promise<boolean> {
    return (await this.enforcementMode()) !== 'off';
  }

  async isRequiredFor(user: {
    roles: string[];
    isGuest: boolean;
  }): Promise<boolean> {
    if (user.isGuest) return false;
    const mode = await this.enforcementMode();
    if (mode === 'off') return false;
    if (mode === 'staff') {
      return user.roles.includes('ADMIN') || user.roles.includes('ORGANIZER');
    }
    return true;
  }
}
