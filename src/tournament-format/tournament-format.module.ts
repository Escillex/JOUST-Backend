import { Module } from '@nestjs/common';
import { TournamentFormatController } from './tournament-format.controller';
import { TournamentFormatService } from './tournament-format.service';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from 'prisma/prisma.module';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [TournamentFormatController],
  providers: [TournamentFormatService],
  exports: [TournamentFormatService],
})
export class TournamentFormatModule {}
