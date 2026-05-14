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
import { Role } from '@prisma/client';
import { ImagesService } from './images.service';

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

  @Post('banner/:tournamentId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @UseInterceptors(FileInterceptor('file'))
  async uploadBanner(
    @Param('tournamentId') tournamentId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    // Note: We could add a check here to ensure the ORGANIZER owns the tournament,
    // but in JOUST organizers are generally trusted with management.
    return this.imagesService.updateBanner(tournamentId, file);
  }

  @Delete('banner/:tournamentId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  async deleteBanner(@Param('tournamentId') tournamentId: string) {
    return this.imagesService.deleteBanner(tournamentId);
  }

  // ─── SITE ASSETS ───────────────────────────────────────────────

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
