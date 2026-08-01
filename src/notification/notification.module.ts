import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { AuthModule } from 'src/auth/auth.module';

// Depends only on Prisma (global), the gateway, and AuthModule for the guard's
// JwtService - nothing in tournament/ or Formats/ - so any module can import it
// without risking a DI cycle.
@Module({
  imports: [RealtimeModule, AuthModule],
  controllers: [NotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
