import {
  Controller,
  Post,
  Patch,
  Get,
  Param,
  Body,
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
import { JwtAuthGuard } from '../../../guards/jwt-auth.guard';
import { RolesGuard } from '../../../guards/roles.guard';
import { Roles } from '../../../guards/decorators/roles.decorator';
import { TournamentAccessGuard } from '../../../guards/tournament-access.guard';
import { TournamentAccess } from '../../../guards/decorators/tournament-access.decorator';
import { Role } from '@prisma/client';

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
   * Auth: staff of this match's tournament (creator or ADMIN)
   * Updates player HP or points values on the active game log.
   * Previously public, on the assumption that players would drive it from their
   * phones. No player-facing UI ever called it, so it is now scoped like every
   * other write. Reintroducing player self-scoring would need a per-match player
   * token, since guests have no credential to check.
   */
  @Patch(':id/tracker/update')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('match:id')
  @HttpCode(HttpStatus.OK)
  updateTracker(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTrackerDto,
  ) {
    return this.trackerService.updateTracker(id, dto);
  }

  /**
   * POST /matches/:id/tracker/submit-game
   * Auth: staff of this match's tournament (creator or ADMIN)
   * Confirms result of current game → closes log → calls reportGameResult().
   */
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
