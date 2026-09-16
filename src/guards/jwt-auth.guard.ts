import { requireJwtSecret } from '../config/security.config';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from 'prisma/prisma.service';
import { Request } from 'express';
import { Role } from '@prisma/client';

/** What a token is FOR. Login is no longer a single step: a password check can
 *  hand back a short-lived token that only permits finishing 2FA or changing a
 *  forced password. Those must never be usable as a session, so every token
 *  carries its purpose and the guards below check it.
 *
 *  Tokens minted before this existed have no `purpose`; they are treated as
 *  `session` so nobody is signed out by the deploy. */
export type TokenPurpose = 'session' | '2fa' | 'password_change';

export interface JwtPayload {
  id: string;
  email: string | null;
  username: string | null;
  roles: Role[];
  purpose?: TokenPurpose;
  /** Issued-at, seconds since the epoch — put there by @nestjs/jwt. Compared
   *  with the account's `sessionsValidFrom` to honour a sign-out-everywhere. */
  iat?: number;
}

/** True when this token may act as a logged-in session. */
export function isSessionToken(payload: JwtPayload): boolean {
  return (payload.purpose ?? 'session') === 'session';
}

export interface AuthenticatedRequest extends Request {
  user: JwtPayload;
}

/** How long a `sessionsValidFrom` reading is reused. A revocation takes effect
 *  within this window — instantly in the process that performed it, since it
 *  clears the entry — rather than costing a database read on every request. */
const REVOCATION_CACHE_MS = 30_000;

@Injectable()
export class JwtAuthGuard implements CanActivate {
  /** userId → the stamp, and when this reading goes stale. Static so every
   *  guard instance (one per module) shares it. */
  private static revokedAt = new Map<string, { at: number | null; until: number }>();

  /** Called after a revocation so the next request re-reads immediately. */
  static forget(userId: string): void {
    JwtAuthGuard.revokedAt.delete(userId);
  }

  constructor(
    private jwtService: JwtService,
    private prisma: PrismaService,
  ) {}

  /** True when this token was issued before the account's sessions were voided. */
  private async isRevoked(payload: JwtPayload): Promise<boolean> {
    if (!payload.iat || !payload.id) return false;
    const now = Date.now();
    let entry = JwtAuthGuard.revokedAt.get(payload.id);
    if (!entry || entry.until < now) {
      const user = await this.prisma.user
        .findUnique({ where: { id: payload.id }, select: { sessionsValidFrom: true } })
        .catch(() => null);
      entry = { at: user?.sessionsValidFrom?.getTime() ?? null, until: now + REVOCATION_CACHE_MS };
      JwtAuthGuard.revokedAt.set(payload.id, entry);
    }
    // Both stamps sit on a whole second (see AccountService), because `iat` is
    // whole seconds: a password change stamps the CURRENT second, so the
    // replacement token minted in it survives, and signing out everywhere
    // stamps the NEXT one, so nothing already issued does.
    return entry.at !== null && payload.iat * 1000 < entry.at;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // Check for token in cookies
    let token = (request.cookies as Record<string, string | undefined>)?.[
      'token'
    ];

    // Fallback: Check for token in Authorization header
    if (!token) {
      const authHeader = request.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
      }
    }

    if (!token) {
      throw new UnauthorizedException('No token found');
    }

    // Only the verification is wrapped: the checks after it throw their own
    // reasons, and a catch-all here would report every one as "Invalid token".
    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync(token, { secret: requireJwtSecret() });
    } catch {
      throw new UnauthorizedException('Invalid token');
    }

    if (!isSessionToken(payload)) {
      // A 2FA challenge or forced-password-change token is proof of one step,
      // not of a session. Accepting it here would make the second factor
      // optional for anyone who kept the intermediate token.
      throw new UnauthorizedException('Invalid token');
    }
    // Ended by "sign out everywhere", or by this account's password changing in
    // another browser.
    if (await this.isRevoked(payload)) {
      throw new UnauthorizedException('Signed out');
    }

    request.user = payload;
    return true;
  }
}
