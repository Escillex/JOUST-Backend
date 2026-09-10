import { Module } from '@nestjs/common';
import { TournamentService } from './tournament.service';
import { TournamentController } from './tournament.controller';
import { RoundModule } from './round/round.module';
import { MatchModule } from './match/match.module';
import { PrismaModule } from 'prisma/prisma.module';
import { JwtModule } from '@nestjs/jwt';
import { FormatsModule } from '../Formats/formats.module';
import { AuthModule } from '../auth/auth.module';
import { LeaderboardModule } from '../leaderboard/leaderboard.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationModule } from '../notification/notification.module';
import { GameModule } from '../game/game.module';
import { forwardRef } from '@nestjs/common';

@Module({
  imports: [
    PrismaModule,
    RoundModule,
    MatchModule,
    forwardRef(() => FormatsModule),
    AuthModule,
    LeaderboardModule,
    RealtimeModule,
    NotificationModule,
    GameModule,
  ],
  controllers: [TournamentController],
  providers: [TournamentService],
  exports: [TournamentService],
})
export class TournamentModule {}
