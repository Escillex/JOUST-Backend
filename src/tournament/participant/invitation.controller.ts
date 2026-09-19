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
import { ParticipantService } from './participant.service';
import { JwtAuthGuard, type AuthenticatedRequest } from 'src/guards/jwt-auth.guard';
import { Audit } from '../../audit/audit.decorator';
import { AuditCategory as AC } from '@prisma/client';

@Controller('participant-invitations')
export class ParticipantInvitationController {
  constructor(private readonly participants: ParticipantService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  async listMine(@Req() req: AuthenticatedRequest) {
    return this.participants.listMyParticipantInvitations(req.user.id);
  }

  @Audit({
    action: 'participant.accept_invite',
    category: AC.PARTICIPANT,
    tournament: { participantInvitationParam: 'id' },
    describe: (c) => `Accepted the invitation to join ${c.t}`,
  })
  @Patch(':id/accept')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async accept(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.participants.respondToParticipantInvitation(id, req.user.id, true);
    return { success: true };
  }

  @Audit({
    action: 'participant.decline_invite',
    category: AC.PARTICIPANT,
    tournament: { participantInvitationParam: 'id' },
    describe: (c) => `Declined the invitation to join ${c.t}`,
  })
  @Patch(':id/decline')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async decline(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.participants.respondToParticipantInvitation(id, req.user.id, false);
    return { success: true };
  }
}
