import { requireJwtSecret } from '../config/security.config';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
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
}

/** True when this token may act as a logged-in session. */
export function isSessionToken(payload: JwtPayload): boolean {
  return (payload.purpose ?? 'session') === 'session';
}

export interface AuthenticatedRequest extends Request {
  user: JwtPayload;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

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

    try {
      const payload: JwtPayload = await this.jwtService.verifyAsync(token, {
        secret: requireJwtSecret(),
      });
      if (!isSessionToken(payload)) {
        // A 2FA challenge or forced-password-change token is proof of one step,
        // not of a session. Accepting it here would make the second factor
        // optional for anyone who kept the intermediate token.
        throw new UnauthorizedException('Invalid token');
      }
      request.user = payload;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }

    return true;
  }
}
