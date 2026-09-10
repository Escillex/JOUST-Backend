import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { SettingsService } from './settings.service';
import { UpdateSettingDto } from './dto/settings.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../guards/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../guards/jwt-auth.guard';

/** Admin-only runtime configuration. Secrets are write-only: `GET` reports
 *  whether one is configured, never what it is. */
@Controller('admin/settings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  list() {
    return this.settings.listForAdmin();
  }

  @Patch()
  async update(
    @Body() dto: UpdateSettingDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = req.user.id || (req.user as any).sub;
    await this.settings.set(dto.name, dto.value, userId);
    return { message: 'Setting updated' };
  }
}
