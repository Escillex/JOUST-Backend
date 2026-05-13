import { Module, forwardRef } from '@nestjs/common';
import { FormatsService } from './formats.service';

import { PrismaModule } from 'prisma/prisma.module';
import { MatchModule } from '../tournament/match/match.module';
import { TournamentModule } from '../tournament/tournament.module';
import { LeaderboardModule } from '../leaderboard/leaderboard.module';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => MatchModule),
    forwardRef(() => TournamentModule),
    LeaderboardModule,
    AuthModule,
  ],
  controllers: [],
  providers: [FormatsService],
  exports: [FormatsService],
})
export class FormatsModule {}
