import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { PrismaModule } from 'prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ImagesController } from './images.controller';
import { ImagesService } from './images.service';
import * as multer from 'multer';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    MulterModule.register({
      storage: multer.memoryStorage(),
    }),
  ],
  controllers: [ImagesController],
  providers: [ImagesService],
  exports: [ImagesService],
})
export class ImagesModule {}
