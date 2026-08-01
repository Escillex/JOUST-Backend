import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { OrganizerService } from './organizer.service';
import { InviteOrganizerDto } from './dto/organizer.dto';
import {
  JwtAuthGuard,
  type AuthenticatedRequest,
} from 'src/guards/jwt-auth.guard';
import { RolesGuard } from 'src/guards/roles.guard';
import { Roles } from 'src/guards/decorators/roles.decorator';
import { TournamentAccessGuard } from 'src/guards/tournament-access.guard';
import { TournamentAccess } from 'src/guards/decorators/tournament-access.decorator';

@Controller('tournaments/:tournamentId/organizers')
export class OrganizerController {
  constructor(private readonly organizers: OrganizerService) {}

  // GET /tournaments/:tournamentId/organizers
  // Anyone who can manage the tournament may see who else can, co-organizers
  // included - so this one does use the access guard.
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard, TournamentAccessGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @TournamentAccess('tournamentId')
  async list(@Param('tournamentId', ParseUUIDPipe) tournamentId: string) {
    return this.organizers.listForTournament(tournamentId);
  }

  // POST /tournaments/:tournamentId/organizers
  // Deliberately NOT access-guarded: the rule here is stricter than the guard,
  // since staff must not be able to recruit staff. The service checks the
  // creator directly.
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  async invite(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Body() dto: InviteOrganizerDto,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.organizers.invite(tournamentId, dto.userId, req.user);
    return { success: true };
  }

  // DELETE /tournaments/:tournamentId/organizers/:userId
  @Delete(':userId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  async revoke(
    @Param('tournamentId', ParseUUIDPipe) tournamentId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.organizers.revoke(tournamentId, userId, req.user);
    return { success: true };
  }
}
