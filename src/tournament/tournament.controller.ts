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

@Controller('tournaments')
export class TournamentController {
  constructor(private readonly tournamentService: TournamentService) {}

  // POST /tournaments
  @Post('createtournament')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  async createTournament(@Body() dto: CreateTournamentDto) {
    return this.tournamentService.createTournament(dto);
  }

  // PATCH /tournaments/:id
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
  @Post('starttournament/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('id')
  @HttpCode(HttpStatus.OK)
  async startTournament(@Param('id', ParseUUIDPipe) id: string) {
    return this.tournamentService.startTournament(id);
  }

  @Patch(':id/complete')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('id')
  completeTournament(@Param('id') id: string) {
    return this.tournamentService.completeTournament(id);
  }

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
