import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { MatchService } from './match.service';
import { SubmitResultDto, GameResultDto } from './dto/match.dto';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/decorators/roles.decorator';
import { TournamentAccessGuard } from '../../guards/tournament-access.guard';
import { TournamentAccess } from '../../guards/decorators/tournament-access.decorator';
import { Role } from '@prisma/client';

@Controller('matches')
export class MatchController {
  constructor(private readonly matchService: MatchService) {}

  // POST /matches/:id/submit
  // Recording a result is a management action: only staff of the match's own
  // tournament may do it. Reads below stay public for spectators.
  @Post(':id/submit')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('match:id')
  @HttpCode(HttpStatus.OK)
  async submitResult(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitResultDto,
  ) {
    return this.matchService.submitResult(id, dto.winnerId);
  }

  // POST /matches/:id/game-result
  @Post(':id/game-result')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('match:id')
  @HttpCode(HttpStatus.OK)
  async reportGameResult(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GameResultDto,
  ) {
    return this.matchService.reportGameResult(id, dto.gameWinnerId);
  }

  // POST /matches/:id/draw was REMOVED (plan 7.3, 2026-07-31).
  //
  // It was never called by the frontend, and it validated strictly less than
  // the draw path in submitResult: it checked only `allowDraw`, skipping the
  // bestOf/pointsThreshold rules AND the per-system guard added in 7.8. That
  // made it a live bypass — an organizer could set allowDraw on a
  // single-elimination tournament and strand the bracket through this route
  // even though /matches/:id/submit refuses. Draws go through submit with no
  // winnerId, which applies every check.

  // GET /matches/:id
  @Get(':id')
  async getMatch(@Param('id', ParseUUIDPipe) id: string) {
    return this.matchService.getMatch(id);
  }

  // GET /matches/round/:roundId
  @Get('round/:roundId')
  async getMatchesByRound(@Param('roundId', ParseUUIDPipe) roundId: string) {
    return this.matchService.getMatchesByRound(roundId);
  }
}
