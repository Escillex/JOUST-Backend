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

    if (!user || !user.roles || user.roles.length === 0) {
      return false;
    }

    const ROLE_HIERARCHY: Record<Role, number> = {
      [Role.ADMIN]: 3,
      [Role.ORGANIZER]: 2,
      [Role.PLAYER]: 1,
    };

    const userRoleLevels = user.roles.map(r => ROLE_HIERARCHY[r] || 0);
    const maxUserRoleLevel = Math.max(...userRoleLevels);

    return requiredRoles.some((role) => {
      const requiredLevel = ROLE_HIERARCHY[role] || 0;
      return maxUserRoleLevel >= requiredLevel;
    });
  }
}
