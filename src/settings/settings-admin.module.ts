import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsModule } from './settings.module';
import { AuthModule } from '../auth/auth.module';

/** The admin-facing settings API. Separate from SettingsModule so that module
 *  can stay free of AuthModule, which depends on it. */
@Module({
  imports: [SettingsModule, AuthModule],
  controllers: [SettingsController],
})
export class SettingsAdminModule {}
