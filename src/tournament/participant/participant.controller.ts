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
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ParticipantService } from './participant.service';
import {
  JoinTournamentDto,
  JoinGuestDto,
  UpdateSeedDto,
  ReplaceParticipantDto,
} from './dto/participant.dto';
import {
  JwtAuthGuard,
  type AuthenticatedRequest,
} from 'src/guards/jwt-auth.guard';
import { RolesGuard } from 'src/guards/roles.guard';
import { Roles } from 'src/guards/decorators/roles.decorator';
import { OptionalJwtAuthGuard } from 'src/guards/optional-jwt-auth.guard';
import { TournamentAccessGuard } from 'src/guards/tournament-access.guard';
import { TournamentAccess } from 'src/guards/decorators/tournament-access.decorator';
import { checkTournamentAccess } from 'src/guards/tournament-access.util';
import { PrismaService } from 'prisma/prisma.service';
import { Role } from '@prisma/client';
import { Audit } from '../../audit/audit.decorator';
import { AuditCategory as AC } from '@prisma/client';

@Controller('tournaments/:tournamentId/participants')
export class ParticipantController {
  constructor(
    private readonly participantService: ParticipantService,
    private readonly prisma: PrismaService,
  ) {}

  // POST /tournaments/:tournamentId/participants/join
  @Audit({ action: 'participant.join', category: AC.PARTICIPANT, tournament: { param: 'tournamentId' }, targetUser: { body: 'userId' }, describe: (c) => (c.self ? `Joined ${c.t}` : `Added ${c.target} to ${c.t}`) })
  @Post('join')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async join(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Body() dto: JoinTournamentDto,
    @Req() req: AuthenticatedRequest,
  ) {
    // Joining yourself is always allowed, which is why this route cannot take
    // TournamentAccessGuard. Adding somebody else is a management action, so it
    // requires access to this specific tournament rather than merely holding the
    // ORGANIZER role.
    if (req.user.id !== dto.userId) {
      const access = await checkTournamentAccess(
        this.prisma,
        tournamentId,
        req.user,
      );
      if (access === 'NOT_FOUND') {
        throw new NotFoundException('Tournament not found');
      }
      if (access !== 'ALLOWED') {
        throw new ForbiddenException(
          'You do not have permission to manage this tournament',
        );
      }
    }
    return this.participantService.joinTournament(tournamentId, dto.userId);
  }

  // POST /tournaments/:tournamentId/participants/guest
  // F7. Guests are an organizer tool now — only tournament staff may register one.
  // Online self-registration is for account holders (the /join route above); the
  // organizer runs the walk-in desk. (Previously this was fully unauthenticated.)
  @Audit({ action: 'participant.add_guest', category: AC.PARTICIPANT, tournament: { param: 'tournamentId' }, pick: ['username'], describe: (c) => `Added guest "${String(c.body.username ?? '')}" to ${c.t}` })
  @Post('guest')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('tournamentId')
  @HttpCode(HttpStatus.CREATED)
  async joinGuest(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Body() dto: JoinGuestDto,
  ) {
    return this.participantService.joinTournamentAsGuest(
      tournamentId,
      dto.username,
    );
  }

  // DELETE /tournaments/:tournamentId/participants/leave
  // Stays reachable without a login so guests can be removed at the registration
  // desk, but the token is read when present so the service can tell a player
  // removing themselves from a stranger removing them.
  @Audit({ action: 'participant.remove', category: AC.PARTICIPANT, tournament: { param: 'tournamentId' }, targetUser: { body: 'userId' }, describe: (c) => (c.self ? `Left ${c.t}` : `Removed ${c.target} from ${c.t}`) })
  @Delete('leave')
  @UseGuards(OptionalJwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async leave(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Body() dto: JoinTournamentDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.participantService.leaveTournament(
      tournamentId,
      dto.userId,
      req.user,
    );
  }

  // GET /tournaments/:tournamentId/participants
  @Get()
  async getParticipants(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
  ) {
    return this.participantService.getParticipants(tournamentId);
  }

  // PATCH /tournaments/:tournamentId/participants/:userId/seed
  @Audit({ action: 'participant.seed', category: AC.PARTICIPANT, tournament: { param: 'tournamentId' }, targetUser: { param: 'userId' }, pick: ['seed'], describe: (c) => `Set ${c.target}'s seed to ${String(c.body.seed)} in ${c.t}` })
  @Patch(':userId/seed')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('tournamentId')
  async updateSeed(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateSeedDto,
  ) {
    return this.participantService.updateSeed(tournamentId, userId, dto.seed);
  }

  // POST /tournaments/:tournamentId/participants/:userId/forfeit
  // The RolesGuard only proves the caller is an organizer at all; the service
  // additionally checks that they own this specific tournament (or are ADMIN).
  @Audit({ action: 'participant.forfeit', category: AC.PARTICIPANT, tournament: { param: 'tournamentId' }, targetUser: { param: 'userId' }, describe: (c) => `Forfeited ${c.target} in ${c.t}` })
  @Post(':userId/forfeit')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('tournamentId')
  @HttpCode(HttpStatus.OK)
  async forfeit(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    await this.participantService.forfeitParticipant(tournamentId, userId);
    return { success: true };
  }

  // POST /tournaments/:tournamentId/participants/:userId/replace
  @Audit({ action: 'participant.replace', category: AC.PARTICIPANT, tournament: { param: 'tournamentId' }, targetUser: { param: 'userId' }, pick: ['substituteUserId', 'guestName'], describe: (c) => `Replaced ${c.target} in ${c.t}${c.body.guestName ? ` with guest "${String(c.body.guestName)}"` : ' with another player'}` })
  @Post(':userId/replace')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('tournamentId')
  @HttpCode(HttpStatus.OK)
  async replace(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ReplaceParticipantDto,
  ) {
    await this.participantService.replaceParticipant(tournamentId, userId, dto);
    return { success: true };
  }
}
