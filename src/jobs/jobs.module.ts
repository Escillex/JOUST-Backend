import { Module } from '@nestjs/common';
import { CleanGuestsJob } from './cleanGuests';
import { MatchTimerJob } from './matchTimer';
import { PrismaModule } from 'prisma/prisma.module';
import { AuthModule } from 'src/auth/auth.module';
import { NotificationModule } from 'src/notification/notification.module';

@Module({
  imports: [PrismaModule, AuthModule, NotificationModule],
  providers: [CleanGuestsJob, MatchTimerJob],
  exports: [CleanGuestsJob, MatchTimerJob],
})
export class JobsModule {}
