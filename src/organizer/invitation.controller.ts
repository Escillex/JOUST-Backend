import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { OrganizerService } from './organizer.service';
import {
  JwtAuthGuard,
  type AuthenticatedRequest,
} from 'src/guards/jwt-auth.guard';

// The invitee's own view. Every route is scoped to req.user.id, so a leaked
// invitation id is not usable by anybody else.
@Controller('organizers/invitations')
export class InvitationController {
  constructor(private readonly organizers: OrganizerService) {}

  // GET /organizers/invitations
  @Get()
  @UseGuards(JwtAuthGuard)
  async listMine(@Req() req: AuthenticatedRequest) {
    return this.organizers.listMyInvitations(req.user.id);
  }

  // PATCH /organizers/invitations/:id/accept
  @Patch(':id/accept')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async accept(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.organizers.respond(id, req.user.id, true);
    return { success: true };
  }

  // PATCH /organizers/invitations/:id/decline
  @Patch(':id/decline')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async decline(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.organizers.respond(id, req.user.id, false);
    return { success: true };
  }
}
