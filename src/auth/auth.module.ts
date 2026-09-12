import { requireJwtSecret, sessionExpiresIn } from '../config/security.config';
import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { TwoFactorService } from './two-factor.service';
import { GoogleAuthService } from './google-auth.service';
import { AuthController } from './auth.controller';
import { JwtModule, JwtSignOptions } from '@nestjs/jwt';
import { PrismaModule } from 'prisma/prisma.module';
import { MailModule } from '../mail/mail.module';
import { SettingsModule } from '../settings/settings.module';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';

@Module({
  imports: [
    PrismaModule,
    // Explicit rather than leaning on @Global: TwoFactorService needs both, and
    // a module that cannot compile on its own is a module that cannot be tested.
    MailModule,
    SettingsModule,
    JwtModule.register({
      secret: requireJwtSecret(),
      // Without this, session tokens never expired: the cookie lapsed after an
      // hour while the Bearer copy in localStorage stayed valid indefinitely, so
      // a leaked token was permanent access.
      // Cast: the lib types this as a template-literal duration, and the value
      // is env-driven, so it is validated by sessionLifetimeMs() at boot instead.
      signOptions: {
        expiresIn: sessionExpiresIn() as JwtSignOptions['expiresIn'],
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, TwoFactorService, GoogleAuthService, JwtAuthGuard, RolesGuard],
  exports: [AuthService, TwoFactorService, JwtAuthGuard, RolesGuard, JwtModule], // export guards and service for use in other modules
})
export class AuthModule {}
