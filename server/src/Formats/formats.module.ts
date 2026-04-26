import { Module, forwardRef } from '@nestjs/common';
import { FormatsService } from './formats.service';
import { FormatsController } from './formats.controller';
import { PrismaModule } from 'prisma/prisma.module';
import { MatchModule } from '../tournament/match/match.module';
import { LeaderboardModule } from '../leaderboard/leaderboard.module';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [PrismaModule, forwardRef(() => MatchModule), LeaderboardModule, AuthModule],
  controllers: [FormatsController],
  providers: [FormatsService],
  exports: [FormatsService],
})
export class FormatsModule {}
