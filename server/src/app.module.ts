import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from 'prisma/prisma.module';
import { TournamentModule } from './tournament/tournament.module';
import { ParticipantModule } from './tournament/participant/participant.module';
import { FormatsModule } from './Formats/formats.module';
import { LeaderboardModule } from './leaderboard/leaderboard.module';

@Module({
  imports: [
    AuthModule,
    PrismaModule,
    TournamentModule,
    ParticipantModule,
    FormatsModule,
    LeaderboardModule,
  ],
})
export class AppModule {}
