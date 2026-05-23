import {
  Controller, Post, Patch, Get,
  Param, Body, ParseUUIDPipe,
  HttpCode, HttpStatus, UseGuards,
} from '@nestjs/common';
import { TrackerService } from './tracker.service';
import { OpenTrackerDto, UpdateTrackerDto, SubmitGameDto } from './dto/tracker.dto';
import { JwtAuthGuard } from '../../../guards/jwt-auth.guard';
import { RolesGuard } from '../../../guards/roles.guard';
import { Roles } from '../../../guards/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Controller('matches')
export class TrackerController {
  constructor(private readonly trackerService: TrackerService) {}

  /**
   * POST /matches/:id/tracker/open
   * Auth: ORGANIZER or ADMIN
   * Opens a new game tracker for the next game in the match series.
   */
  @Post(':id/tracker/open')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  openTracker(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OpenTrackerDto,
  ) {
    return this.trackerService.openTracker(id, dto);
  }

  /**
   * PATCH /matches/:id/tracker/update
   * Auth: Public (players update from phone; organizer has full override)
   * Updates player HP or points values on the active game log.
   */
  @Patch(':id/tracker/update')
  @HttpCode(HttpStatus.OK)
  updateTracker(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTrackerDto,
  ) {
    return this.trackerService.updateTracker(id, dto);
  }

  /**
   * POST /matches/:id/tracker/submit-game
   * Auth: ORGANIZER or ADMIN
   * Confirms result of current game → closes log → calls reportGameResult().
   */
  @Post(':id/tracker/submit-game')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
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
