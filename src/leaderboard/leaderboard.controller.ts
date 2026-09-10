import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { LeaderboardService } from './leaderboard.service';
import { OptionalJwtAuthGuard } from '../guards/optional-jwt-auth.guard';
import type { AuthenticatedRequest } from '../guards/jwt-auth.guard';

@Controller('tournaments')
export class LeaderboardController {
  constructor(private readonly leaderboardService: LeaderboardService) {}

  /** Per-game boards are public. The **cross-game** board (no `?game=`) is
   *  ADMIN-only (2026-09-10): pooling every game into one ranking compares
   *  players who have never played the same thing, so it is an operator's view
   *  of the platform, not a competitive standing anyone should be ranked in.
   *
   *  Enforced here, not just hidden in the UI — a tab the client declines to
   *  render is not a restriction, it is a suggestion. OptionalJwtAuthGuard keeps
   *  the per-game boards open to logged-out spectators while still identifying
   *  an admin.
   */
  @Get('leaderboard/global')
  @UseGuards(OptionalJwtAuthGuard)
  getGlobalLeaderboard(
    @Req() req: AuthenticatedRequest,
    @Query('game') game?: string,
  ) {
    if (!game) {
      const roles = req.user?.roles ?? [];
      if (!roles.includes(Role.ADMIN)) {
        throw new ForbiddenException({
          message:
            'The combined all-games leaderboard is available to administrators. Choose a game.',
          code: 'CROSS_GAME_BOARD_ADMIN_ONLY',
        });
      }
    }
    return this.leaderboardService.getGlobalLeaderboard(game || undefined);
  }

  @Get('leaderboard/games')
  getGames() {
    return this.leaderboardService.getGames();
  }

  @Get(':tournamentId/leaderboard')
  getLeaderboard(@Param('tournamentId') tournamentId: string) {
    return this.leaderboardService.getLeaderboard(tournamentId);
  }

  /** A single player's own lifetime figures (and their rank within the combined
   *  board). Deliberately still public: this is one player's own record, which
   *  their profile has always shown — not the ranking table above. */
  @Get('users/:userId/stats')
  getUserStats(@Param('userId') userId: string) {
    return this.leaderboardService.getUserStats(userId);
  }
}
