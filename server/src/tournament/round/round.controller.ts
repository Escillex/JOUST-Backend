// tournament/round/round.controller.ts

import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { RoundService } from './round.service';

@Controller('tournaments/:tournamentId/rounds')
export class RoundController {
  constructor(private readonly roundService: RoundService) {}

  // GET /tournaments/:tournamentId/rounds
  @Get()
  async getRounds(@Param('tournamentId', ParseUUIDPipe) tournamentId: string) {
    return this.roundService.getRounds(tournamentId);
  }

  // GET /tournaments/:tournamentId/rounds/:roundNumber
  @Get(':roundNumber')
  async getRound(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Param('roundNumber') roundNumber: string,
  ) {
    return this.roundService.getRound(tournamentId, +roundNumber);
  }
}
