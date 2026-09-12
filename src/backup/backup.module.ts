import { Module } from '@nestjs/common';
import { PrismaModule } from 'prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { AuthModule } from '../auth/auth.module';
import { BackupService } from './backup.service';
import { BackupController } from './backup.controller';
import { BackupJob } from './backup.job';

@Module({
  // AuthModule supplies JwtService, which JwtAuthGuard on the controller needs.
  imports: [PrismaModule, SettingsModule, AuthModule],
  controllers: [BackupController],
  providers: [BackupService, BackupJob],
  exports: [BackupService, BackupJob],
})
export class BackupModule {}
