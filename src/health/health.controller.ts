import { Controller, Get } from '@nestjs/common';

/**
 * Liveness only — deliberately unauthenticated, and a GET, which is the rule
 * for every unguarded endpoint here.
 *
 * It exists because a restore restarts the server: the browser needs something
 * cheap to poll to know when it is back, and an authenticated route cannot be
 * that (the token check itself needs the app up).
 */
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }
}
