import { Module, forwardRef } from '@nestjs/common';
import { ParticipantService } from './participant.service';
import { ParticipantController } from './participant.controller';
import { PrismaModule } from 'prisma/prisma.module';
import { AuthModule } from 'src/auth/auth.module';
import { MatchModule } from '../match/match.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { NotificationModule } from 'src/notification/notification.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    // MatchModule sits in the tournament <-> formats forwardRef cluster; nothing
    // in that chain imports ParticipantModule today, so this is not resolving an
    // existing cycle, only keeping the import safe if one is ever introduced.
    forwardRef(() => MatchModule),
    RealtimeModule,
    NotificationModule,
  ],
  controllers: [ParticipantController],
  providers: [ParticipantService],
  exports: [ParticipantService],
})
export class ParticipantModule {}
