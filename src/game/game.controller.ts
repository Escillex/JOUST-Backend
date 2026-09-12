import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  Req,
} from '@nestjs/common';
import { GameService } from './game.service';
import { CreateGameDto, UpdateGameDto } from './dto/create-game.dto';
import { RequestGameDto } from './dto/request-game.dto';
import { ResolveRequestDto } from './dto/resolve-request.dto';
import { GameRequestStatus } from '@prisma/client';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../guards/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { Audit } from '../audit/audit.decorator';
import { AuditCategory as AC } from '@prisma/client';

@Controller('games')
export class GameController {
  constructor(private readonly service: GameService) {}

  /** GET /games — public catalog of assignable games. Retired system rows (the
   *  old "General" placeholder) are excluded unless `?includeSystem=true`, which
   *  the admin catalog manager passes so historical assignments stay visible. */
  @Get()
  list(@Query('includeSystem') includeSystem?: string) {
    return this.service.list(includeSystem === 'true' || includeSystem === '1');
  }

  /** POST /games/request — organizer asks admins for a missing game.
   *  Declared before ':id' routes; it shares no verb with them so there is no
   *  clash, but keeping it here documents that it is not an :id route. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @Audit({ action: 'game.request', category: AC.CATALOG, tournament: { body: 'tournamentId' }, pick: ['name', 'tournamentId'], describe: (c) => `Requested the game "${String(c.body.name ?? '')}"${c.body.tournamentId ? ` for ${c.t}` : ''}` })
  @Post('request')
  request(@Body() dto: RequestGameDto, @Req() req: any) {
    return this.service.request(dto, {
      id: req.user?.id ?? req.user?.sub,
      username: req.user?.username,
    });
  }

  /** GET /games/requests — the admin queue. Declared before ':id' so "requests"
   *  is not read as a game id. Defaults to PENDING; pass ?status= to widen. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @Get('requests')
  listRequests(@Query('status') status?: GameRequestStatus) {
    return this.service.listRequests(status ?? GameRequestStatus.PENDING);
  }

  /** PATCH /games/requests/:id — resolve or dismiss a request. ADMIN only. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @Audit({ action: 'game.request_resolve', category: AC.CATALOG, pick: ['status'], describe: (c) => `Marked a game request ${String(c.body.status ?? '').toLowerCase()}` })
  @Patch('requests/:id')
  resolveRequest(@Param('id') id: string, @Body() dto: ResolveRequestDto) {
    return this.service.resolveRequest(id, dto);
  }

  /** GET /games/:id — public */
  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  /** POST /games — ADMIN only */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @Audit({ action: 'game.create', category: AC.CATALOG, pick: ['name'], describe: (c) => `Added the game "${String(c.body.name ?? '')}"` })
  @Post()
  create(@Body() dto: CreateGameDto, @Req() req: any) {
    const userId = req.user?.id ?? req.user?.sub;
    return this.service.create(dto, userId);
  }

  /** PATCH /games/:id — ADMIN only */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @Audit({ action: 'game.update', category: AC.CATALOG, subject: { model: 'game', param: 'id' }, describe: (c) => `Edited the game "${c.subject}" (${c.fields.join(', ') || 'no changes'})` })
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateGameDto) {
    return this.service.update(id, dto);
  }

  /** DELETE /games/:id — ADMIN only */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @Audit({ action: 'game.delete', category: AC.CATALOG, subject: { model: 'game', param: 'id' }, describe: (c) => `Deleted the game "${c.subject}"` })
  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
