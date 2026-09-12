import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  Req,
} from '@nestjs/common';
import { TournamentFormatService } from './tournament-format.service';
import {
  CreateTournamentFormatDto,
  UpdateTournamentFormatDto,
} from './dto/create-format.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../guards/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { Audit } from '../audit/audit.decorator';
import { AuditCategory as AC } from '@prisma/client';

@Controller('tournament-formats')
export class TournamentFormatController {
  constructor(private readonly service: TournamentFormatService) {}

  /** GET /tournament-formats — public */
  @Get()
  list() {
    return this.service.list();
  }

  /** GET /tournament-formats/:id — public */
  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  /** POST /tournament-formats — ADMIN only */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @Audit({ action: 'format.create', category: AC.CATALOG, pick: ['name', 'system'], describe: (c) => `Created the format preset "${String(c.body.name ?? '')}"` })
  @Post()
  create(@Body() dto: CreateTournamentFormatDto, @Req() req: any) {
    const userId = req.user?.id ?? req.user?.sub;
    return this.service.create(dto, userId);
  }

  /** PATCH /tournament-formats/:id — ADMIN only */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @Audit({ action: 'format.update', category: AC.CATALOG, subject: { model: 'tournamentFormat', param: 'id' }, describe: (c) => `Edited the format preset "${c.subject}" (${c.fields.join(', ') || 'no changes'})` })
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTournamentFormatDto,
    @Req() req: any,
  ) {
    return this.service.update(id, dto, req.user?.roles ?? []);
  }

  /** DELETE /tournament-formats/:id — ADMIN only */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @Audit({ action: 'format.delete', category: AC.CATALOG, subject: { model: 'tournamentFormat', param: 'id' }, describe: (c) => `Deleted the format preset "${c.subject}"` })
  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
