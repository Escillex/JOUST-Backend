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
} from '@nestjs/common';
import { TournamentService } from './tournament.service';
import { CreateTournamentDto, UpdateTournamentDto } from './dto/tournament.dto';
import { Roles } from 'src/guards/decorators/roles.decorator';
import { RolesGuard } from 'src/guards/roles.guard';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';

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
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  async updateTournament(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTournamentDto,
  ) {
    return this.tournamentService.updateTournament(id, dto);
  }

  // POST /tournaments/:id/start
  @Post('starttournament/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  async startTournament(@Param('id', ParseUUIDPipe) id: string) {
    return this.tournamentService.startTournament(id);
  }

  @Patch(':id/complete')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  completeTournament(@Param('id') id: string) {
    return this.tournamentService.completeTournament(id);
  }

  // GET /tournaments/:id
  @Get(':id')
  async getTournament(@Param('id', ParseUUIDPipe) id: string) {
    return this.tournamentService.getTournament(id);
  }

  // GET /tournaments
  @Get()
  async getAllTournaments() {
    return this.tournamentService.getAllTournaments();
  }
}
