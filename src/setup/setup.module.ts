import { Module } from '@nestjs/common';
import { SetupController } from './setup.controller';
import { SettingsModule } from '../settings/settings.module';
import { AuthModule } from '../auth/auth.module';

/** Separate from SettingsModule for the same reason SettingsAdminModule is:
 *  SettingsModule must not depend on AuthModule, which depends on it. */
@Module({
  imports: [SettingsModule, AuthModule],
  controllers: [SetupController],
})
export class SetupModule {}
