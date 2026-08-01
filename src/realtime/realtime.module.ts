import { requireJwtSecret } from '../config/security.config';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { RealtimeGateway } from './realtime.gateway';

// Owns the single Socket.IO gateway. It only needs JwtService to read the
// optional identity cookie during the handshake, so it registers JwtModule
// with the same secret used everywhere else rather than importing AuthModule.
// The gateway depends on nothing in tournament/ or Formats/, so the modules
// that emit through it can import this one without creating a DI cycle.
@Module({
  imports: [
    JwtModule.register({
      secret: requireJwtSecret(),
    }),
  ],
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
