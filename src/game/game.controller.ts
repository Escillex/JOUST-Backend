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
import { CreateGameDto } from './dto/create-game.dto';
import { RequestGameDto } from './dto/request-game.dto';
import { ResolveRequestDto } from './dto/resolve-request.dto';
import { GameRequestStatus } from '@prisma/client';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../guards/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Controller('games')
export class GameController {
  constructor(private readonly service: GameService) {}

  /** GET /games — public catalog */
  @Get()
  list() {
    return this.service.list();
  }

  /** POST /games/request — organizer asks admins for a missing game.
   *  Declared before ':id' routes; it shares no verb with them so there is no
   *  clash, but keeping it here documents that it is not an :id route. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
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
  @Post()
  create(@Body() dto: CreateGameDto, @Req() req: any) {
    const userId = req.user?.id ?? req.user?.sub;
    return this.service.create(dto, userId);
  }

  /** PATCH /games/:id — ADMIN only */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: Partial<CreateGameDto>) {
    return this.service.update(id, dto);
  }

  /** DELETE /games/:id — ADMIN only */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
