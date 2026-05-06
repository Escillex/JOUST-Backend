import { Module } from '@nestjs/common';
import { CleanGuestsJob } from './cleanGuests';
import { PrismaModule } from 'prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [CleanGuestsJob],
  exports: [CleanGuestsJob],
})
export class JobsModule {}
