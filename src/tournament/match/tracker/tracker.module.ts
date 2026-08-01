import { Module, forwardRef } from '@nestjs/common';
import { TrackerService } from './tracker.service';
import { TrackerController } from './tracker.controller';
import { PrismaModule } from 'prisma/prisma.module';
import { MatchModule } from '../match.module';
import { AuthModule } from '../../../auth/auth.module';
import { RealtimeModule } from '../../../realtime/realtime.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => MatchModule),
    AuthModule,
    RealtimeModule,
  ],
  controllers: [TrackerController],
  providers: [TrackerService],
  exports: [TrackerService],
})
export class TrackerModule {}
