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
import { RolesGuard } from '../../../guards/roles.guard';
import { Roles } from '../../../guards/decorators/roles.decorator';
import { TournamentAccessGuard } from '../../../guards/tournament-access.guard';
import { TournamentAccess } from '../../../guards/decorators/tournament-access.decorator';
import { Role } from '@prisma/client';
import { Audit, matchText } from '../../../audit/audit.decorator';
import { AuditCategory as AC } from '@prisma/client';

@Controller('matches')
export class TrackerController {
  constructor(private readonly trackerService: TrackerService) {}

  /**
   * POST /matches/:id/tracker/open
   * Auth: staff of this match's tournament (creator or ADMIN)
   * Opens a new game tracker for the next game in the match series.
   */
  @Post(':id/tracker/open')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('match:id')
  @HttpCode(HttpStatus.CREATED)
  openTracker(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OpenTrackerDto,
  ) {
    return this.trackerService.openTracker(id, dto);
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
   * Auth: staff of this match's tournament (creator or ADMIN)
   * Confirms result of current game → closes log → calls reportGameResult().
   */
  @Audit({ action: 'match.tracker_game', category: AC.MATCH, tournament: { matchParam: 'id' }, describe: (c) => `Submitted a tracked game for ${matchText(c)} in ${c.t}` })
  @Post(':id/tracker/submit-game')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('match:id')
  @HttpCode(HttpStatus.OK)
  submitGame(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitGameDto,
  ) {
    return this.trackerService.submitGame(id, dto);
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
