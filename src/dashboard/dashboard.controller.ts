import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { DashboardService } from './dashboard.service';

/**
 * The signed-in home page, in one request.
 *
 * Read-only and strictly self-scoped — the user id comes from the token, never
 * from a parameter, so there is no way to ask for somebody else's dashboard.
 */
@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  get(@Req() req: any) {
    const userId = req.user?.sub || req.user?.id;
    return this.dashboard.getDashboard(userId);
  }
}
