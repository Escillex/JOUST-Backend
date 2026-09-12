import {
  Controller,
  Post,
  Delete,
  Get,
  Param,
  UseInterceptors,
  UploadedFile,
  UseGuards,
  Req,
  ForbiddenException,
  Body,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../guards/decorators/roles.decorator';
import { TournamentAccessGuard } from '../guards/tournament-access.guard';
import { TournamentAccess } from '../guards/decorators/tournament-access.decorator';
import { Role } from '@prisma/client';
import { ImagesService } from './images.service';
import { Audit } from '../audit/audit.decorator';
import { AuditCategory as AC } from '@prisma/client';

@Controller('images')
export class ImagesController {
  constructor(private readonly imagesService: ImagesService) {}

  // ─── USER AVATAR ───────────────────────────────────────────────

  @Post('avatar/:userId')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file'))
  async uploadAvatar(
    @Param('userId') userId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    const myId = req.user.id;
    const isAdmin = req.user.roles.includes(Role.ADMIN);

    if (myId !== userId && !isAdmin) {
      throw new ForbiddenException('You can only update your own avatar');
    }

    return this.imagesService.updateAvatar(userId, file);
  }

  @Delete('avatar/:userId')
  @UseGuards(JwtAuthGuard)
  async deleteAvatar(@Param('userId') userId: string, @Req() req: any) {
    const myId = req.user.id;
    const isAdmin = req.user.roles.includes(Role.ADMIN);

    if (myId !== userId && !isAdmin) {
      throw new ForbiddenException('You can only delete your own avatar');
    }

    return this.imagesService.deleteAvatar(userId);
  }

  // ─── TOURNAMENT BANNER ──────────────────────────────────────────

  @Audit({ action: 'tournament.banner', category: AC.TOURNAMENT, tournament: { param: 'tournamentId' }, describe: (c) => `Changed the banner of ${c.t}` })
  @Post('banner/:tournamentId')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('tournamentId')
  @UseInterceptors(FileInterceptor('file'))
  async uploadBanner(
    @Param('tournamentId') tournamentId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.imagesService.updateBanner(tournamentId, file);
  }

  @Audit({ action: 'tournament.banner_remove', category: AC.TOURNAMENT, tournament: { param: 'tournamentId' }, describe: (c) => `Removed the banner of ${c.t}` })
  @Delete('banner/:tournamentId')
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('tournamentId')
  async deleteBanner(@Param('tournamentId') tournamentId: string) {
    return this.imagesService.deleteBanner(tournamentId);
  }

  // ─── SITE ASSETS ───────────────────────────────────────────────

  @Audit({ action: 'system.asset', category: AC.SYSTEM, describe: (c) => `Uploaded the site asset "${c.params.key}"` })
  @Post('assets/:key')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @UseInterceptors(FileInterceptor('file'))
  async uploadAsset(
    @Param('key') key: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('label') label?: string,
  ) {
    return this.imagesService.upsertAsset(key, file, label);
  }

  @Audit({ action: 'system.asset_remove', category: AC.SYSTEM, describe: (c) => `Removed the site asset "${c.params.key}"` })
  @Delete('assets/:key')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  async deleteAsset(@Param('key') key: string) {
    return this.imagesService.deleteAsset(key);
  }

  @Get('assets')
  async getAssets() {
    return this.imagesService.getAllAssets();
  }
}
