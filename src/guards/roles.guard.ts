import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ROLES_KEY } from './decorators/roles.decorator';
import { AuthenticatedRequest } from './jwt-auth.guard';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!user || !user.roles || !Array.isArray(user.roles) || user.roles.length === 0) {
      console.warn(`[RolesGuard] Denied: User has no roles. ID: ${user?.id}`);
      return false;
    }

    const ROLE_HIERARCHY: Record<string, number> = {
      [Role.ADMIN]: 3,
      [Role.ORGANIZER]: 2,
      [Role.PLAYER]: 1,
    };

    const userRoleLevels = user.roles.map((r) => ROLE_HIERARCHY[r as string] || 0);
    const maxUserRoleLevel = Math.max(...userRoleLevels);

    const isAuthorized = requiredRoles.some((role) => {
      const requiredLevel = ROLE_HIERARCHY[role as string];
      if (requiredLevel === undefined) {
        console.error(`[RolesGuard] Error: Required role "${role}" not found in hierarchy.`);
        return false;
      }
      return maxUserRoleLevel >= requiredLevel;
    });

    if (!isAuthorized) {
      console.warn(
        `[RolesGuard] Denied: Insufficient permissions. User roles: [${user.roles.join(', ')}], Required: [${requiredRoles.join(', ')}]`,
      );
    }

    return isAuthorized;
  }
}
