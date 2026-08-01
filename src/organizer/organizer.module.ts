import { Module } from '@nestjs/common';
import { OrganizerService } from './organizer.service';
import { OrganizerController } from './organizer.controller';
import { InvitationController } from './invitation.controller';
import { NotificationModule } from 'src/notification/notification.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [NotificationModule, RealtimeModule, AuthModule],
  controllers: [OrganizerController, InvitationController],
  providers: [OrganizerService],
  exports: [OrganizerService],
})
export class OrganizerModule {}
