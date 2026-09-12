import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { PrismaService } from 'prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { generateUniqueUserSlug } from '../user/user-slug.util';
import { AuthService } from './auth.service';

/** What we take from a verified Google ID token. */
export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  /** Workspace domain, absent for personal accounts. */
  hd: string | null;
}

/**
 * "Sign in with Google", configured entirely from Admin → Settings.
 *
 * The Client ID comes from the DEPLOYER's own Google Cloud project, read per
 * request, so each deployment shows its own name on Google's consent screen and
 * a change applies without a restart. It uses Google's ID-token flow: the
 * browser gets a signed token from Google and this verifies it (signature,
 * audience = our Client ID, issuer, expiry). No client secret exists in this
 * flow, so nothing sensitive is stored for Google at all.
 *
 * Account matching is the part that matters, because email addresses in this
 * database were never verified before 2FA arrived — so matching purely on email
 * would let someone take over an account in either direction:
 *
 *   googleId matches                 → sign in
 *   email matches, NO password       → link, sign in
 *   email matches, HAS a password    → refuse; sign in with the password and
 *                                      connect Google from the profile instead
 *   no match                         → create a verified account
 *
 * A Google session skips the emailed code: Google has already done its own
 * second-factor check, and asking again adds friction without adding security.
 */
@Injectable()
export class GoogleAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly auth: AuthService,
  ) {}

  async config() {
    const [enabled, clientId, allowedDomain] = await Promise.all([
      this.settings.getBoolean('GOOGLE_SIGNIN_ENABLED'),
      this.settings.get('GOOGLE_CLIENT_ID'),
      this.settings.get('GOOGLE_ALLOWED_DOMAIN'),
    ]);
    const id = clientId?.trim() || null;
    return {
      // Switched on AND configured: an enabled toggle with no Client ID would
      // render a Google button that can only ever fail.
      enabled: enabled && !!id,
      clientId: id,
      allowedDomain: allowedDomain?.trim().toLowerCase() || null,
    };
  }

  /** Public: what the sign-in page may offer. The Client ID is public by
   *  design — Google's script needs it in the browser. */
  async providers() {
    const c = await this.config();
    return { google: { enabled: c.enabled, clientId: c.enabled ? c.clientId : null } };
  }

  /** Network call to Google's keys; separated so tests can substitute it. */
  async verifyCredential(credential: string, clientId: string): Promise<GoogleIdentity> {
    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
    const p = ticket.getPayload();
    if (!p?.sub || !p.email) throw new Error('Google token carried no identity');
    return {
      sub: p.sub,
      email: p.email,
      emailVerified: p.email_verified === true,
      name: p.name ?? null,
      hd: p.hd ?? null,
    };
  }

  private async identify(credential: string): Promise<GoogleIdentity> {
    const c = await this.config();
    if (!c.enabled || !c.clientId) {
      throw new ForbiddenException({
        code: 'GOOGLE_SIGNIN_DISABLED',
        message: 'Google sign-in is not enabled on this site.',
      });
    }

    let id: GoogleIdentity;
    try {
      id = await this.verifyCredential(credential, c.clientId);
    } catch {
      throw new UnauthorizedException('Google could not confirm that sign-in. Please try again.');
    }

    if (!id.emailVerified) {
      throw new UnauthorizedException("That Google account's email address is not verified.");
    }
    if (c.allowedDomain && (id.hd ?? '').toLowerCase() !== c.allowedDomain) {
      throw new ForbiddenException({
        code: 'GOOGLE_DOMAIN_NOT_ALLOWED',
        message: `Only ${c.allowedDomain} Google accounts can sign in here.`,
      });
    }
    return { ...id, email: id.email.trim().toLowerCase() };
  }

  async signIn(credential: string, res: Response) {
    const id = await this.identify(credential);

    const linked = await this.prisma.user.findUnique({ where: { googleId: id.sub } });
    if (linked) {
      return { ...(await this.auth.startSession(linked, res)), via: 'google' };
    }

    const byEmail = await this.prisma.user.findFirst({
      where: { email: { equals: id.email, mode: 'insensitive' }, isGuest: false },
    });
    if (byEmail) {
      if (byEmail.hashedPassword) {
        throw new ConflictException({
          code: 'GOOGLE_EMAIL_HAS_PASSWORD',
          message:
            'An account with this email already signs in with a password. Sign in with your password, then connect Google from Edit Profile.',
        });
      }
      const user = await this.prisma.user.update({
        where: { id: byEmail.id },
        data: { googleId: id.sub, emailVerified: true, emailVerifiedAt: new Date() },
      });
      return { ...(await this.auth.startSession(user, res)), via: 'google', linked: true };
    }

    const username = await this.uniqueUsername(id.email);
    const user = await this.prisma.user.create({
      data: {
        username,
        displayName: id.name?.trim().slice(0, 50) || null,
        slug: await generateUniqueUserSlug(this.prisma, username),
        email: id.email,
        emailVerified: true,
        emailVerifiedAt: new Date(),
        googleId: id.sub,
        roles: [Role.PLAYER],
        // No password: this account signs in with Google. The owner can set
        // one later from Edit Profile.
      },
    });
    return { ...(await this.auth.startSession(user, res)), via: 'google', created: true };
  }

  /** Connect Google to the signed-in account — the path the refusal above
   *  points password users to. */
  async link(userId: string, credential: string) {
    const id = await this.identify(credential);
    const holder = await this.prisma.user.findUnique({ where: { googleId: id.sub } });
    if (holder && holder.id !== userId) {
      throw new ConflictException({
        code: 'GOOGLE_ALREADY_LINKED',
        message: 'That Google account is already connected to a different account.',
      });
    }
    await this.prisma.user.update({ where: { id: userId }, data: { googleId: id.sub } });
    return { googleLinked: true, email: id.email };
  }

  /** Disconnecting must never lock someone out: an account with no password
   *  has no other way in. */
  async unlink(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { hashedPassword: true },
    });
    if (!user?.hashedPassword) {
      throw new BadRequestException(
        'Set a password before disconnecting Google — otherwise there would be no way to sign in.',
      );
    }
    await this.prisma.user.update({ where: { id: userId }, data: { googleId: null } });
    return { googleLinked: false };
  }

  /**
   * A username from the Google address that satisfies USERNAME_PATTERN (no
   * spaces; letters, digits, . _ -), 3–20 characters, and is unique
   * case-insensitively — "Paul" and "paul" are the same person here.
   */
  private async uniqueUsername(email: string): Promise<string> {
    let base = email.split('@')[0].replace(/[^A-Za-z0-9._-]/g, '').slice(0, 16);
    if (base.length < 3) base = `${base}player`.slice(0, 16);
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? base : `${base}${n}`.slice(0, 20);
      const taken = await this.prisma.user.findFirst({
        where: { username: { equals: candidate, mode: 'insensitive' } },
        select: { id: true },
      });
      if (!taken) return candidate;
    }
  }
}
