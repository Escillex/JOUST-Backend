import { Module, forwardRef } from '@nestjs/common';
import { FormatsService } from './formats.service';
import { FormatsController } from './formats.controller';
import { PrismaModule } from 'prisma/prisma.module';
import { MatchModule } from '../tournament/match/match.module';
import { LeaderboardModule } from '../leaderboard/leaderboard.module';

@Module({
  imports: [PrismaModule, forwardRef(() => MatchModule), LeaderboardModule],
  controllers: [FormatsController],
  providers: [FormatsService],
  exports: [FormatsService],
})
export class FormatsModule {}
