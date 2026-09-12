// tournament/tournament.controller.ts

import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Patch,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
  Req,
  Query,
} from '@nestjs/common';
import { TournamentService } from './tournament.service';
import {
  CreateTournamentDto,
  UpdateTournamentDto,
  TournamentStatusDto,
  ReassignGameDto,
} from './dto/tournament.dto';
import { Roles } from '../guards/decorators/roles.decorator';
import { RolesGuard } from '../guards/roles.guard';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import type { AuthenticatedRequest } from '../guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../guards/optional-jwt-auth.guard';
import { TournamentAccessGuard } from '../guards/tournament-access.guard';
import { TournamentAccess } from '../guards/decorators/tournament-access.decorator';
import { Audit } from '../audit/audit.decorator';
import { AuditCategory as AC } from '@prisma/client';

@Controller('tournaments')
export class TournamentController {
  constructor(private readonly tournamentService: TournamentService) {}

  // POST /tournaments
  @Audit({ action: 'tournament.create', category: AC.TOURNAMENT, tournament: { result: 'id' }, describe: (c) => `Created tournament ${c.t}` })
  @Post('createtournament')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  async createTournament(
    @Body() dto: CreateTournamentDto,
    @Req() req: AuthenticatedRequest,
  ) {
    // Owner is always the authenticated caller — never taken from the body (F3).
    return this.tournamentService.createTournament(dto, req.user.id);
  }

  // PATCH /tournaments/:id
  @Audit({ action: 'tournament.update', category: AC.TOURNAMENT, tournament: { param: 'id' }, describe: (c) => `Edited ${c.t} (${c.fields.join(', ') || 'no changes'})` })
  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('id')
  async updateTournament(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTournamentDto,
  ) {
    return this.tournamentService.updateTournament(id, dto);
  }

  // PATCH /tournaments/:id/game — reassign the game (any status; staff-gated)
  @Audit({ action: 'tournament.reassign_game', category: AC.TOURNAMENT, tournament: { param: 'id' }, pick: ['gameId'], describe: (c) => `Changed the game of ${c.t}` })
  @Patch(':id/game')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('id')
  async reassignGame(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReassignGameDto,
  ) {
    return this.tournamentService.reassignGame(id, dto.gameId);
  }

  @Audit({ action: 'tournament.status', category: AC.TOURNAMENT, tournament: { param: 'id' }, pick: ['status'], describe: (c) => `Set ${c.t} to ${String(c.body.status)}` })
  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('id')
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TournamentStatusDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.tournamentService.updateStatus(id, dto, req.user);
  }

  @Audit({ action: 'tournament.generate_bracket', category: AC.TOURNAMENT, tournament: { param: 'id' }, describe: (c) => `Generated the bracket for ${c.t}` })
  @Post(':id/generate-bracket')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('id')
  @HttpCode(HttpStatus.OK)
  async generateBracket(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.tournamentService.generateBracket(id, req.user);
  }

  // POST /tournaments/:id/start
  @Audit({ action: 'tournament.start', category: AC.TOURNAMENT, tournament: { param: 'id' }, describe: (c) => `Started ${c.t}` })
  @Post('starttournament/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('id')
  @HttpCode(HttpStatus.OK)
  async startTournament(@Param('id', ParseUUIDPipe) id: string) {
    return this.tournamentService.startTournament(id);
  }

  @Audit({ action: 'tournament.complete', category: AC.TOURNAMENT, tournament: { param: 'id' }, describe: (c) => `Completed ${c.t}` })
  @Patch(':id/complete')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('id')
  completeTournament(@Param('id') id: string) {
    return this.tournamentService.completeTournament(id);
  }

  @Audit({ action: 'tournament.resolve_tie', category: AC.TOURNAMENT, tournament: { param: 'id' }, pick: ['action'], describe: (c) => `Resolved a tie in ${c.t} (${c.body.action === 'EXTEND_ROUND' ? 'extra round added' : 'tie-breakers applied'})` })
  @Post(':id/resolve-tie')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('id')
  resolveTie(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('action') action: 'EXTEND_ROUND' | 'APPLY_TIEBREAKERS',
  ) {
    return this.tournamentService.resolveTie(id, action);
  }

  @Audit({ action: 'tournament.cancel_cleanup', category: AC.TOURNAMENT, tournament: { param: 'id' }, describe: (c) => `Cancelled the scheduled guest cleanup for ${c.t}` })
  @Patch(':id/cancel-cleanup')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('id')
  cancelCleanup(@Param('id') id: string) {
    return this.tournamentService.cancelCleanup(id);
  }

  // GET /tournaments/:id
  // Public: spectators and invite links read this without an account. The
  // optional guard attaches the caller when a token happens to be present, which
  // is what lets the response carry an accurate canManage flag.
  /** `?view=summary` omits the rounds/matches tree — see getTournament (7.1). */
  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  async getTournament(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
    @Query('view') view?: string,
  ) {
    return this.tournamentService.getTournament(
      id,
      req.user,
      view === 'summary' ? 'summary' : 'full',
    );
  }

  @Get('invite/:token')
  async getTournamentByInviteToken(@Param('token') token: string) {
    return this.tournamentService.getTournamentByInviteToken(token);
  }

  // GET /tournaments
  // Public listing by default. With ?manageable=true it returns only the
  // tournaments this caller may manage, which is what the organizer's manage
  // list uses - the client cannot compute that itself.
  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  async getAllTournaments(
    @Query('manageable') manageable: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.tournamentService.getAllTournaments(
      req.user,
      manageable === 'true',
    );
  }
}
