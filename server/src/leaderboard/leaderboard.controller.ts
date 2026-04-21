import { Controller, Get, Param } from '@nestjs/common';
import { LeaderboardService } from './leaderboard.service';

@Controller('tournaments')
export class LeaderboardController {
  constructor(private readonly leaderboardService: LeaderboardService) {}

  @Get(':tournamentId/leaderboard')
  getLeaderboard(@Param('tournamentId') tournamentId: string) {
    return this.leaderboardService.getLeaderboard(tournamentId);
  }
}