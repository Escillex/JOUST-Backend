import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuditCategory, Role } from '@prisma/client';
import { AuditService } from './audit.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../guards/decorators/roles.decorator';

/** The admin dashboard's view of what organizers and admins did. ADMIN only. */
@Controller('admin/audit')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(
    @Query('category') category?: string,
    @Query('q') search?: string,
    @Query('tournamentId') tournamentId?: string,
    @Query('actorId') actorId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const cat = category && category in AuditCategory ? (category as AuditCategory) : undefined;
    return this.audit.list({
      category: cat,
      search: search?.trim() || undefined,
      tournamentId: tournamentId || undefined,
      actorId: actorId || undefined,
      cursor: cursor || undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
