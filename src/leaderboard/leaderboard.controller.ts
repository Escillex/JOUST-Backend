import { Controller, Get, Param, Query } from '@nestjs/common';
import { LeaderboardService } from './leaderboard.service';

@Controller('tournaments')
export class LeaderboardController {
  constructor(private readonly leaderboardService: LeaderboardService) {}

  @Get('leaderboard/global')
  getGlobalLeaderboard(@Query('game') game?: string) {
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

  @Get('users/:userId/stats')
  getUserStats(@Param('userId') userId: string) {
    return this.leaderboardService.getUserStats(userId);
  }
}
