// tournament/participant/participant.controller.ts

import {
  Controller,
  Post,
  Delete,
  Get,
  Param,
  Body,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ParticipantService } from './participant.service';
import { JoinTournamentDto } from './dto/participant.dto';

@Controller('tournaments/:tournamentId/participants')
export class ParticipantController {
  constructor(private readonly participantService: ParticipantService) {}

  // POST /tournaments/:tournamentId/participants/join
  @Post('join')
  @HttpCode(HttpStatus.CREATED)
  async join(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Body() dto: JoinTournamentDto,
  ) {
    return this.participantService.joinTournament(tournamentId, dto);
  }

  // DELETE /tournaments/:tournamentId/participants/leave
  @Delete('leave')
  @HttpCode(HttpStatus.OK)
  async leave(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Body() dto: JoinTournamentDto,
  ) {
    return this.participantService.leaveTournament(tournamentId, dto.userId);
  }

  // GET /tournaments/:tournamentId/participants
  @Get()
  async getParticipants(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
  ) {
    return this.participantService.getParticipants(tournamentId);
  }
}
