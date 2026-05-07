import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from 'prisma/prisma.module';
import { TournamentModule } from './tournament/tournament.module';
import { ParticipantModule } from './tournament/participant/participant.module';
import { FormatsModule } from './Formats/formats.module';
import { LeaderboardModule } from './leaderboard/leaderboard.module';
import { JobsModule } from './jobs/jobs.module';
import { UserModule } from './user/user.module';
import { DevModule } from './dev/dev.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    AuthModule,
    PrismaModule,
    TournamentModule,
    ParticipantModule,
    FormatsModule,
    LeaderboardModule,
    JobsModule,
    UserModule,
    DevModule,
  ],
})
export class AppModule { }
