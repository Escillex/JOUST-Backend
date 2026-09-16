import { Global, Module, forwardRef } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from 'prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AuditService } from './audit.service';
import { AuditInterceptor } from './audit.interceptor';
import { AuditController } from './audit.controller';

/**
 * Global on purpose, unlike the other modules: the interceptor is registered
 * app-wide and every feature module's routes carry `@Audit(...)`, so nothing
 * should have to import this to be audited.
 */
@Global()
@Module({
  // forwardRef: AuthModule imports this one back (AccountService records a
  // self-deletion).
  imports: [PrismaModule, forwardRef(() => AuthModule)],
  controllers: [AuditController],
  providers: [AuditService, { provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
  exports: [AuditService],
})
export class AuditModule {}
