import { requireJwtSecret } from '../config/security.config';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AuthenticatedRequest, JwtPayload } from './jwt-auth.guard';

/** Attaches req.user when a valid token is present and permits the request either
 *  way. Used by routes that must stay open to spectators, guests, and logged-out
 *  visitors but still need to know who is asking - JwtAuthGuard cannot be used
 *  there because it rejects anonymous callers outright. */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    let token = (request.cookies as Record<string, string | undefined>)?.[
      'token'
    ];
    if (!token) {
      const authHeader = request.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) token = authHeader.split(' ')[1];
    }
    if (!token) return true;

    try {
      request.user = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret: requireJwtSecret(),
      });
    } catch {
      // A bad or expired token is treated as anonymous rather than as an error:
      // these routes are public, and a stale cookie must not break reading a
      // bracket or removing a guest at the registration desk.
    }
    return true;
  }
}
