import { Module } from '@nestjs/common';
import { PrismaModule } from 'prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ImagesModule } from '../images/images.module';
import { NotificationModule } from '../notification/notification.module';
import { AwardService } from './award.service';
import {
  AwardCatalogController,
  AwardGrantController,
  ShowcaseController,
} from './award.controller';

@Module({
  // AuthModule supplies JwtService for JwtAuthGuard. Leaving it out type-checks
  // cleanly and only fails when the container boots (it did, for BackupModule).
  imports: [PrismaModule, AuthModule, ImagesModule, NotificationModule],
  controllers: [ShowcaseController, AwardCatalogController, AwardGrantController],
  providers: [AwardService],
})
export class AwardModule {}
