import { Module } from '@nestjs/common';
import { CleanGuestsJob } from './cleanGuests';
import { PrismaModule } from 'prisma/prisma.module';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [PrismaModule, AuthModule],
  providers: [CleanGuestsJob],
  exports: [CleanGuestsJob],
})
export class JobsModule {}
