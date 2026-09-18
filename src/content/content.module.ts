import { Module } from '@nestjs/common';
import { PrismaModule } from 'prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ImagesModule } from '../images/images.module';
import { NotificationModule } from '../notification/notification.module';
import { BuildService } from './build.service';
import { GalleryService } from './gallery.service';
import { ModerationService } from './moderation.service';
import { ModerationJob } from './moderation.job';
import {
  BuildController,
  GalleryController,
  ModerationController,
  ReportController,
} from './content.controller';

/** User-uploaded content — tournament builds, profile galleries — and the
 *  moderation around it (todo.md obj. 4.3). AuditService comes from the global
 *  AuditModule; AuthModule supplies JwtService for the guards. */
@Module({
  imports: [PrismaModule, AuthModule, ImagesModule, NotificationModule],
  controllers: [
    BuildController,
    GalleryController,
    ReportController,
    ModerationController,
  ],
  providers: [BuildService, GalleryService, ModerationService, ModerationJob],
  exports: [BuildService, GalleryService],
})
export class ContentModule {}
