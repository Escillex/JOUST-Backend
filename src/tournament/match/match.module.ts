import { Module, forwardRef } from '@nestjs/common';
import { MatchService } from './match.service';
import { MatchController } from './match.controller';
import { PrismaModule } from 'prisma/prisma.module';
import { FormatsModule } from '../../Formats/formats.module';
import { TrackerModule } from './tracker/tracker.module';

@Module({
  imports: [PrismaModule, forwardRef(() => FormatsModule), forwardRef(() => TrackerModule)],
  controllers: [MatchController],
  providers: [MatchService],
  exports: [MatchService],
})
export class MatchModule {}
