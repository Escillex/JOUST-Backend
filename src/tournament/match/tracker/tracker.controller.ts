import {
  Controller,
  Post,
  Patch,
  Get,
  Param,
  Body,
  Req,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { TrackerService } from './tracker.service';
import {
  OpenTrackerDto,
  UpdateTrackerDto,
  SubmitGameDto,
} from './dto/tracker.dto';
import {
  JwtAuthGuard,
  type AuthenticatedRequest,
} from '../../../guards/jwt-auth.guard';
import { Audit, matchText } from '../../../audit/audit.decorator';
import { AuditCategory as AC } from '@prisma/client';

@Controller('matches')
export class TrackerController {
  constructor(private readonly trackerService: TrackerService) {}

  /**
   * POST /matches/:id/tracker/open
   * Auth: authenticated, then authorized in the service — staff always; a
   * *participant of this match* when the tournament's scoreSubmissionRule allows
   * player scoring. Like tracker/update and start, the rule depends on the
   * tournament's config, which a guard cannot read, so it is decided here
   * rather than by RolesGuard/TournamentAccessGuard.
   */
  @Post(':id/tracker/open')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  openTracker(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OpenTrackerDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.trackerService.openTracker(id, dto, req.user);
  }

  /**
   * PATCH /matches/:id/tracker/update
   * Auth: any authenticated user, then authorized in the service — the tournament's
   * staff may set either side; a *participant of this match* may set only their own
   * slot (self-scoring). Organizers keep final say (open + submit-game are staff-
   * only). Deliberately NOT guarded by RolesGuard/TournamentAccessGuard here: those
   * would reject a PLAYER before the per-match ownership check can run. Guests have
   * no credential, so JwtAuthGuard keeps them out and they stay organizer-driven.
   */
  @Patch(':id/tracker/update')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  updateTracker(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTrackerDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.trackerService.updateTracker(id, dto, req.user);
  }

  /**
   * POST /matches/:id/tracker/submit-game
   * Auth: authenticated, then authorized in the service — staff always; a
   * *participant of this match* when the tournament allows player scoring. A
   * player-driven result that decides the series is deferred into pending
   * verification rather than completing immediately (organizer has the final
   * review). Deliberately NOT guarded by RolesGuard/TournamentAccessGuard: a
   * guard would reject the player before the per-match rule can run.
   */
  @Audit({
    action: 'match.tracker_game',
    category: AC.MATCH,
    tournament: { matchParam: 'id' },
    describe: (c) => `Submitted a tracked game for ${matchText(c)} in ${c.t}`,
  })
  @Post(':id/tracker/submit-game')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  submitGame(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitGameDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.trackerService.submitGame(id, dto, req.user);
  }

  /**
   * GET /matches/:id/tracker
   * Auth: Public (spectator polling, ~4s interval)
   * Returns all MatchGameLog rows for the match ordered by gameNumber ASC.
   */
  @Get(':id/tracker')
  getTrackerLogs(@Param('id', ParseUUIDPipe) id: string) {
    return this.trackerService.getTrackerLogs(id);
  }
}
