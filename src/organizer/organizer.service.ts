import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { NotificationType, OrganizerInviteStatus, Role } from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';
import { NotificationService } from 'src/notification/notification.service';
import { RealtimeGateway } from 'src/realtime/realtime.gateway';
import type { JwtPayload } from 'src/guards/jwt-auth.guard';

/** Staff management for one tournament. Note this is deliberately STRICTER than
 *  TournamentAccessGuard: that guard admits accepted co-organizers, but staff
 *  must not be able to recruit further staff, so inviting and revoking check the
 *  creator directly instead of going through the guard. */
@Injectable()
export class OrganizerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** Creator-or-admin only. Keeps the authority chain traceable to one person. */
  private async assertCreatorOrAdmin(tournamentId: string, actor: JwtPayload) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      select: { id: true, name: true, createdById: true },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');

    const isAdmin = actor.roles?.includes(Role.ADMIN);
    if (tournament.createdById !== actor.id && !isAdmin) {
      throw new ForbiddenException(
        'Only the tournament creator can manage its staff',
      );
    }
    return tournament;
  }

  async invite(
    tournamentId: string,
    targetUserId: string,
    actor: JwtPayload,
  ): Promise<void> {
    const tournament = await this.assertCreatorOrAdmin(tournamentId, actor);

    if (tournament.createdById === targetUserId) {
      throw new BadRequestException(
        'The tournament creator already manages this tournament',
      );
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, roles: true },
    });
    if (!target) throw new NotFoundException('User not found');

    // Checked here rather than left to fail at first use: RolesGuard would block
    // them on every managed endpoint anyway, so an invitation they could never
    // use is worse than an immediate, explainable rejection.
    if (
      !target.roles?.includes(Role.ORGANIZER) &&
      !target.roles?.includes(Role.ADMIN)
    ) {
      throw new BadRequestException(
        'That user must have the organizer role before they can be invited',
      );
    }

    const existing = await this.prisma.tournamentOrganizer.findUnique({
      where: { tournamentId_userId: { tournamentId, userId: targetUserId } },
    });
    if (existing?.status === OrganizerInviteStatus.ACCEPTED) {
      throw new BadRequestException(
        'That user already co-manages this tournament',
      );
    }
    if (existing?.status === OrganizerInviteStatus.PENDING) {
      throw new BadRequestException(
        'That user already has a pending invitation',
      );
    }

    // upsert rather than create: a DECLINED row is reset to PENDING, so a decline
    // is never permanent and the unique constraint still holds.
    await this.prisma.tournamentOrganizer.upsert({
      where: { tournamentId_userId: { tournamentId, userId: targetUserId } },
      create: {
        tournamentId,
        userId: targetUserId,
        invitedById: actor.id,
        status: OrganizerInviteStatus.PENDING,
      },
      update: {
        status: OrganizerInviteStatus.PENDING,
        invitedById: actor.id,
        respondedAt: null,
      },
    });

    await this.notifications.notify({
      userId: targetUserId,
      type: NotificationType.ORGANIZER_INVITED,
      title: `You were invited to co-manage ${tournament.name}`,
      body: 'Open the tournament to accept or decline.',
      link: `/tournaments/${tournamentId}`,
      tournamentId,
    });

    this.realtime.emitTournamentUpdated(tournamentId);
  }

  /** The staff list for one tournament, for the manage page. */
  async listForTournament(tournamentId: string) {
    return this.prisma.tournamentOrganizer.findMany({
      where: { tournamentId },
      orderBy: { createdAt: 'asc' },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
          },
        },
      },
    });
  }

  /** The caller's own pending invitations, for the inbox and the banner. */
  async listMyInvitations(userId: string) {
    return this.prisma.tournamentOrganizer.findMany({
      where: { userId, status: OrganizerInviteStatus.PENDING },
      orderBy: { createdAt: 'desc' },
      include: {
        tournament: { select: { id: true, name: true } },
      },
    });
  }

  async respond(
    invitationId: string,
    userId: string,
    accept: boolean,
  ): Promise<void> {
    const invitation = await this.prisma.tournamentOrganizer.findUnique({
      where: { id: invitationId },
    });
    // 404 rather than 403 when it is somebody else's: a leaked invitation id
    // must not even confirm that it exists.
    if (!invitation || invitation.userId !== userId) {
      throw new NotFoundException('Invitation not found');
    }
    if (invitation.status !== OrganizerInviteStatus.PENDING) {
      throw new BadRequestException(
        'This invitation has already been answered',
      );
    }

    await this.prisma.tournamentOrganizer.update({
      where: { id: invitationId },
      data: {
        status: accept
          ? OrganizerInviteStatus.ACCEPTED
          : OrganizerInviteStatus.DECLINED,
        respondedAt: new Date(),
      },
    });

    this.realtime.emitTournamentUpdated(invitation.tournamentId);
  }

  async revoke(
    tournamentId: string,
    targetUserId: string,
    actor: JwtPayload,
  ): Promise<void> {
    await this.assertCreatorOrAdmin(tournamentId, actor);

    const existing = await this.prisma.tournamentOrganizer.findUnique({
      where: { tournamentId_userId: { tournamentId, userId: targetUserId } },
    });
    if (!existing) {
      throw new NotFoundException('That user is not staff on this tournament');
    }

    await this.prisma.tournamentOrganizer.delete({
      where: { id: existing.id },
    });

    // Emitted so an open staff panel - and the revoked person's own page -
    // refresh promptly. Their already-loaded canManage stays stale until then,
    // but the guard rejects every action regardless, so this is a cosmetic lag
    // rather than an access leak.
    this.realtime.emitTournamentUpdated(tournamentId);
  }
}
