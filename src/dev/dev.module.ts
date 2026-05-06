import { Module } from '@nestjs/common';
import { DevService } from './dev.service';
import { DevController } from './dev.controller';
import { TournamentModule } from '../tournament/tournament.module';
import { ParticipantModule } from '../tournament/participant/participant.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [TournamentModule, ParticipantModule, AuthModule],
  providers: [DevService],
  controllers: [DevController],
})
export class DevModule {}
