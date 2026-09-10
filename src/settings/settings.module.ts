import { Global, Module } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { PrismaModule } from 'prisma/prisma.module';

/**
 * The settings *service* only — deliberately no controller, and deliberately no
 * dependency on AuthModule.
 *
 * AuthModule needs settings (2FA enforcement) and the settings controller needs
 * Auth's guards; putting both in one module makes that a cycle. Splitting the
 * admin controller into SettingsAdminModule keeps the graph acyclic.
 *
 * Still `@Global` for convenience, but every consumer imports it explicitly as
 * well: relying on global registration alone means a module cannot be compiled
 * on its own, which is exactly what `test/di-boot.e2e-spec.ts` checks.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
