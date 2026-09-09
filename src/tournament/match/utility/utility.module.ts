import { Module } from '@nestjs/common';
import { MatchUtilityService } from './utility.service';
import { MatchUtilityController } from './utility.controller';
import { PrismaModule } from 'prisma/prisma.module';
import { AuthModule } from '../../../auth/auth.module';
import { RealtimeModule } from '../../../realtime/realtime.module';

@Module({
  imports: [PrismaModule, AuthModule, RealtimeModule],
  controllers: [MatchUtilityController],
  providers: [MatchUtilityService],
  exports: [MatchUtilityService],
})
export class MatchUtilityModule {}
