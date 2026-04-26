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
  Req,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { ParticipantService } from './participant.service';
import { JoinTournamentDto, JoinGuestDto } from './dto/participant.dto';
import { JwtAuthGuard, type AuthenticatedRequest } from 'src/guards/jwt-auth.guard';

@Controller('tournaments/:tournamentId/participants')
export class ParticipantController {
  constructor(private readonly participantService: ParticipantService) {}

  // POST /tournaments/:tournamentId/participants/join
  @Post('join')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async join(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Body() dto: JoinTournamentDto,
    @Req() req: AuthenticatedRequest,
  ) {
    if (req.user.sub !== dto.userId) {
      throw new UnauthorizedException('Cannot join as another user');
    }
    return this.participantService.joinTournament(tournamentId, dto.userId);
  }

  // POST /tournaments/:tournamentId/participants/guest
  @Post('guest')
  @HttpCode(HttpStatus.CREATED)
  async joinGuest(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Body() dto: JoinGuestDto,
  ) {
    return this.participantService.joinTournamentAsGuest(tournamentId, dto.guestName);
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
