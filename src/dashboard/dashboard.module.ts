import { Module } from '@nestjs/common';
import { PrismaModule } from 'prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { LeaderboardModule } from '../leaderboard/leaderboard.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  // AuthModule supplies JwtService for JwtAuthGuard — without it the app
  // type-checks and then fails to boot.
  imports: [PrismaModule, AuthModule, LeaderboardModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
