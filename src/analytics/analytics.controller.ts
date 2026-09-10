import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../guards/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Controller('admin/analytics')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AnalyticsController {
  constructor(private readonly service: AnalyticsService) {}

  /** GET /admin/analytics?months=12 — one aggregated payload for the admin
   *  ANALYTICS tab. `months` is clamped to 1–24 by the service. */
  @Get()
  overview(@Query('months') months?: string) {
    return this.service.getOverview(months ? Number(months) : undefined);
  }
}
