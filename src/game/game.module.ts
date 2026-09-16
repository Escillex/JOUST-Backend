import { Module } from '@nestjs/common';
import { GameController } from './game.controller';
import { GameService } from './game.service';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from 'prisma/prisma.module';
import { NotificationModule } from '../notification/notification.module';
import { ImagesModule } from '../images/images.module';

@Module({
  imports: [PrismaModule, AuthModule, NotificationModule, ImagesModule],
  controllers: [GameController],
  providers: [GameService],
  exports: [GameService],
})
export class GameModule {}
