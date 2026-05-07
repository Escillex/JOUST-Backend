// tournament/participant/participant.controller.ts

import {
  Controller,
  Post,
  Delete,
  Get,
  Patch,
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
import { JoinTournamentDto, JoinGuestDto, UpdateSeedDto } from './dto/participant.dto';
import { JwtAuthGuard, type AuthenticatedRequest } from 'src/guards/jwt-auth.guard';
import { RolesGuard } from 'src/guards/roles.guard';
import { Roles } from 'src/guards/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Controller('tournaments/:tournamentId/participants')
export class ParticipantController {
  constructor(private readonly participantService: ParticipantService) { }

  // POST /tournaments/:tournamentId/participants/join
  @Post('join')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async join(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Body() dto: JoinTournamentDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const roles = req.user.roles || [];
    const isAuthorized = roles.includes(Role.ADMIN) || roles.includes(Role.ORGANIZER);

    if (req.user.id !== dto.userId && !isAuthorized) {
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
    return this.participantService.joinTournamentAsGuest(tournamentId, dto.username);
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

  // PATCH /tournaments/:tournamentId/participants/:userId/seed
  @Patch(':userId/seed')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  async updateSeed(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateSeedDto,
  ) {
    return this.participantService.updateSeed(tournamentId, userId, dto.seed);
  }
}
