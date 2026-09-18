import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuditCategory as AC, Role } from '@prisma/client';
import { Audit } from '../audit/audit.decorator';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import type { AuthenticatedRequest } from '../guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../guards/optional-jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../guards/decorators/roles.decorator';
import { TournamentAccessGuard } from '../guards/tournament-access.guard';
import { TournamentAccess } from '../guards/decorators/tournament-access.decorator';
import { BuildService } from './build.service';
import { GalleryService } from './gallery.service';
import { ModerationService } from './moderation.service';
import {
  BuildSettingsDto,
  GalleryCaptionDto,
  ModerationRemoveDto,
  ModerationTargetDto,
  ReportDto,
  ReviewBuildDto,
  SubmitBuildDto,
} from './dto/content.dto';

/** Player photos are resized to 1600px on the server; nothing larger is useful. */
const PHOTO = FileInterceptor('image', {
  limits: { fileSize: 8 * 1024 * 1024 },
});
const uid = (req: AuthenticatedRequest) =>
  req.user.id || (req.user as { sub?: string }).sub!;

/** Tournament builds (obj. 4.3). */
@Controller('tournaments/:tournamentId/builds')
export class BuildController {
  constructor(private readonly builds: BuildService) {}

  /** Filtered for the viewer: staff see everything, the owner sees theirs, and
   *  everyone else sees only what the tournament's visibility allows. */
  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  list(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.builds.list(tournamentId, req.user);
  }

  @Put('me')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(PHOTO)
  submit(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Body() dto: SubmitBuildDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.builds.submit(tournamentId, uid(req), dto, file);
  }

  @Delete('me')
  @UseGuards(JwtAuthGuard)
  withdraw(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.builds.withdraw(tournamentId, uid(req));
  }

  @Audit({
    action: 'build.review',
    category: AC.PARTICIPANT,
    tournament: { param: 'tournamentId' },
    pick: ['decision', 'note'],
    describe: (c) =>
      `${c.body.decision === 'APPROVED' ? 'Approved' : 'Rejected'} a build in ${c.t}${c.body.note ? ` (${String(c.body.note)})` : ''}`,
  })
  @Patch(':buildId/review')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('tournamentId')
  review(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Param('buildId', ParseUUIDPipe) buildId: string,
    @Body() dto: ReviewBuildDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.builds.review(tournamentId, buildId, uid(req), dto);
  }

  @Audit({
    action: 'build.settings',
    category: AC.TOURNAMENT,
    tournament: { param: 'tournamentId' },
    pick: ['buildsRequired', 'buildVisibility', 'buildsLockAtStart'],
    describe: (c) =>
      `Changed build settings for ${c.t} (${Object.entries(c.body)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(', ')})`,
  })
  @Patch('settings')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('tournamentId')
  settings(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Body() dto: BuildSettingsDto,
  ) {
    return this.builds.updateSettings(tournamentId, dto);
  }
}

/** The caller's own profile gallery (obj. 4.3). */
@Controller('users/me/gallery')
@UseGuards(JwtAuthGuard)
export class GalleryController {
  constructor(private readonly gallery: GalleryService) {}

  @Get()
  mine(@Req() req: AuthenticatedRequest) {
    return this.gallery.mine(uid(req));
  }

  @Put(':gameId')
  @UseInterceptors(PHOTO)
  upsert(
    @Param('gameId', ParseUUIDPipe) gameId: string,
    @Body() dto: GalleryCaptionDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.gallery.upsert(uid(req), gameId, file, dto.caption);
  }

  @Delete(':gameId')
  remove(
    @Param('gameId', ParseUUIDPipe) gameId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.gallery.remove(uid(req), gameId);
  }
}

/** Reporting — any signed-in user. From an organizer it is a removal request. */
@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportController {
  constructor(private readonly moderation: ModerationService) {}

  @Post()
  report(@Body() dto: ReportDto, @Req() req: AuthenticatedRequest) {
    return this.moderation.report(req.user as never, dto);
  }
}

/** The admin moderation queue. ADMIN only — only admins remove content. */
@Controller('admin/moderation')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Get()
  queue(@Query('view') view?: string) {
    return this.moderation.queue(view === 'removed' ? 'removed' : 'open');
  }

  @Get('count')
  count() {
    return this.moderation.openCount();
  }

  @Audit({
    action: 'moderation.remove',
    category: AC.MODERATION,
    pick: ['targetType', 'targetId', 'reason'],
    describe: (c) =>
      `Removed a ${c.body.targetType === 'GALLERY_IMAGE' ? 'gallery image' : 'tournament build'} (${String(c.body.reason)})`,
  })
  @Post('remove')
  remove(@Body() dto: ModerationRemoveDto, @Req() req: AuthenticatedRequest) {
    return this.moderation.remove(req.user as never, dto);
  }

  @Audit({
    action: 'moderation.dismiss',
    category: AC.MODERATION,
    pick: ['targetType', 'targetId'],
    describe: (c) =>
      `Dismissed reports on a ${c.body.targetType === 'GALLERY_IMAGE' ? 'gallery image' : 'tournament build'}`,
  })
  @Post('dismiss')
  dismiss(@Body() dto: ModerationTargetDto, @Req() req: AuthenticatedRequest) {
    return this.moderation.dismiss(req.user as never, dto);
  }

  @Audit({
    action: 'moderation.restore',
    category: AC.MODERATION,
    pick: ['targetType', 'targetId'],
    describe: (c) =>
      `Restored a removed ${c.body.targetType === 'GALLERY_IMAGE' ? 'gallery image' : 'tournament build'}`,
  })
  @Post('restore')
  restore(@Body() dto: ModerationTargetDto) {
    return this.moderation.restore(dto);
  }
}
