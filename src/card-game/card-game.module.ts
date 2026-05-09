import { Module } from '@nestjs/common';
import { CardGameService } from './card-game.service';
import { CardGameController } from './card-game.controller';
import { PrismaModule } from 'prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, AuthModule],
  providers: [CardGameService],
  controllers: [CardGameController],
})
export class CardGameModule {}
