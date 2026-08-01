import { Module, forwardRef } from '@nestjs/common';
import { MatchService } from './match.service';
import { MatchController } from './match.controller';
import { PrismaModule } from 'prisma/prisma.module';
import { FormatsModule } from '../../Formats/formats.module';
import { TrackerModule } from './tracker/tracker.module';
import { AuthModule } from '../../auth/auth.module';
import { NotificationModule } from '../../notification/notification.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => FormatsModule),
    forwardRef(() => TrackerModule),
    // MatchController's writes are now behind JwtAuthGuard, which needs the
    // JwtService that AuthModule exports.
    AuthModule,
    NotificationModule,
  ],
  controllers: [MatchController],
  providers: [MatchService],
  exports: [MatchService],
})
export class MatchModule {}
