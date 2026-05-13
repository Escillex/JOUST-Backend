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
import { CreateTournamentFormatDto } from './dto/create-format.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../guards/decorators/roles.decorator';
import { Role } from '@prisma/client';

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
  @Post()
  create(@Body() dto: CreateTournamentFormatDto, @Req() req: any) {
    const userId = req.user?.id ?? req.user?.sub;
    return this.service.create(dto, userId);
  }

  /** PATCH /tournament-formats/:id — ADMIN only */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: Partial<CreateTournamentFormatDto>,
    @Req() req: any,
  ) {
    return this.service.update(id, dto, req.user?.roles ?? []);
  }

  /** DELETE /tournament-formats/:id — ADMIN only */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
