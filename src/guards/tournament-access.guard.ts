import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from 'prisma/prisma.service';
import type { AuthenticatedRequest } from './jwt-auth.guard';
import { checkTournamentAccess } from './tournament-access.util';
import {
  TOURNAMENT_ACCESS_KEY,
  type TournamentAccessSource,
} from './decorators/tournament-access.decorator';

/** Restricts a route to the tournament's creator and platform admins. Runs after
 *  JwtAuthGuard and RolesGuard: those answer "is this a logged-in organizer at
 *  all", this answers "on this particular tournament". */
@Injectable()
export class TournamentAccessGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const source = this.reflector.getAllAndOverride<TournamentAccessSource>(
      TOURNAMENT_ACCESS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // A route that uses this guard but forgets the decorator is a configuration
    // mistake. Fail closed: failing open is exactly how the original holes appeared.
    if (!source) {
      throw new ForbiddenException(
        'Route is missing its @TournamentAccess configuration',
      );
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const params = request.params as Record<string, string | undefined>;

    const tournamentId = await this.resolveTournamentId(source, params);
    if (!tournamentId) throw new NotFoundException('Tournament not found');

    const result = await checkTournamentAccess(
      this.prisma,
      tournamentId,
      request.user,
    );

    if (result === 'NOT_FOUND') {
      throw new NotFoundException('Tournament not found');
    }
    if (result === 'DENIED') {
      throw new ForbiddenException(
        'You do not have permission to manage this tournament',
      );
    }
    return true;
  }

  private async resolveTournamentId(
    source: TournamentAccessSource,
    params: Record<string, string | undefined>,
  ): Promise<string | null> {
    if (source === 'match:id') {
      const matchId = params.id;
      if (!matchId) return null;
      // One query rather than two: the round join carries the tournament id.
      const match = await this.prisma.match.findUnique({
        where: { id: matchId },
        select: { round: { select: { tournamentId: true } } },
      });
      return match?.round?.tournamentId ?? null;
    }
    return params[source] ?? null;
  }
}
