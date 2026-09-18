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
  Req,
} from '@nestjs/common';
import { MatchService } from './match.service';
import { SubmitResultDto, GameResultDto } from './dto/match.dto';
import {
  JwtAuthGuard,
  type AuthenticatedRequest,
} from '../../guards/jwt-auth.guard';
import { RolesGuard } from '../../guards/roles.guard';
import { Roles } from '../../guards/decorators/roles.decorator';
import { TournamentAccessGuard } from '../../guards/tournament-access.guard';
import { TournamentAccess } from '../../guards/decorators/tournament-access.decorator';
import { Role } from '@prisma/client';
import { Audit, matchText } from '../../audit/audit.decorator';
import { AuditCategory as AC } from '@prisma/client';

@Controller('matches')
export class MatchController {
  constructor(private readonly matchService: MatchService) {}

  // POST /matches/:id/submit
  // Recording a result is a management action: only staff of the match's own
  // tournament may do it. Reads below stay public for spectators.
  @Audit({
    action: 'match.result',
    category: AC.MATCH,
    tournament: { matchParam: 'id' },
    targetUser: { body: 'winnerId' },
    pick: ['winnerId'],
    describe: (c) =>
      c.body.winnerId
        ? `Recorded ${c.target} as the winner of ${matchText(c)} in ${c.t}`
        : `Recorded a draw in ${matchText(c)} in ${c.t}`,
  })
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

  // POST /matches/:id/self-report
  @Audit({
    action: 'match.self_report',
    category: AC.MATCH,
    tournament: { matchParam: 'id' },
    targetUser: { body: 'winnerId' },
    pick: ['winnerId'],
    describe: (c) =>
      `Self-reported ${c.target} as the winner of ${matchText(c)} in ${c.t}`,
  })
  @Post(':id/self-report')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async selfReportResult(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitResultDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.matchService.selfReportResult(id, dto.winnerId, req.user);
  }

  // POST /matches/:id/verify
  @Audit({
    action: 'match.verify',
    category: AC.MATCH,
    tournament: { matchParam: 'id' },
    describe: (c) =>
      `Verified player-reported score for ${matchText(c)} in ${c.t}`,
  })
  @Post(':id/verify')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('match:id')
  @HttpCode(HttpStatus.OK)
  async verifyResult(@Param('id', ParseUUIDPipe) id: string) {
    return this.matchService.verifyResult(id);
  }

  // POST /matches/:id/reject-report
  @Audit({
    action: 'match.reject_report',
    category: AC.MATCH,
    tournament: { matchParam: 'id' },
    describe: (c) =>
      `Rejected player-reported score for ${matchText(c)} in ${c.t}`,
  })
  @Post(':id/reject-report')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('match:id')
  @HttpCode(HttpStatus.OK)
  async rejectReportedResult(@Param('id', ParseUUIDPipe) id: string) {
    return this.matchService.rejectReportedResult(id);
  }

  // POST /matches/:id/reset
  @Audit({
    action: 'match.reset',
    category: AC.MATCH,
    tournament: { matchParam: 'id' },
    describe: (c) =>
      `Reset and rolled back score for ${matchText(c)} in ${c.t}`,
  })
  @Post(':id/reset')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('match:id')
  @HttpCode(HttpStatus.OK)
  async resetMatch(@Param('id', ParseUUIDPipe) id: string) {
    return this.matchService.resetMatch(id);
  }

  // POST /matches/:id/game-result
  @Audit({
    action: 'match.game_result',
    category: AC.MATCH,
    tournament: { matchParam: 'id' },
    targetUser: { body: 'gameWinnerId' },
    pick: ['gameWinnerId'],
    describe: (c) =>
      `Recorded a game won by ${c.target} in ${matchText(c)} in ${c.t}`,
  })
  @Post(':id/game-result')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async reportGameResult(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GameResultDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.matchService.reportGameResult(id, dto.gameWinnerId, req.user);
  }

  // POST /matches/:id/start
  // Who may start is decided by the tournament's `matchStartWho` config in
  // MatchService.startMatch — by default the two players plus staff. Deliberately
  // NOT guarded by RolesGuard/TournamentAccessGuard here: those would reject a
  // PLAYER before the per-match rule can run, the same shape as tracker/update.
  @Audit({
    action: 'match.start',
    category: AC.MATCH,
    tournament: { matchParam: 'id' },
    describe: (c) => `Started ${matchText(c)} in ${c.t}`,
  })
  @Post(':id/start')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async startMatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.matchService.startMatch(id, req.user);
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
