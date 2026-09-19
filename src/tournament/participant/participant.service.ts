import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { TournamentService } from '../tournament.service';
import { MatchService } from '../match/match.service';
import { RealtimeGateway } from 'src/realtime/realtime.gateway';
import { NotificationService } from 'src/notification/notification.service';
import {
  ParticipantStatus,
  MatchStatus,
  NotificationType,
  ParticipantInviteStatus,
  Prisma,
} from '@prisma/client';
import { JwtPayload } from 'src/guards/jwt-auth.guard';
import { checkTournamentAccess } from 'src/guards/tournament-access.util';

@Injectable()
export class ParticipantService {
  constructor(
    private prisma: PrismaService,
    private matchService: MatchService,
    private realtime: RealtimeGateway,
    private notifications: NotificationService,
  ) {}

  // ✅ JOIN TOURNAMENT
  async joinTournament(tournamentId: string, userId: string) {
    // 1. Check tournament exists
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: { participants: true },
    });

    if (!tournament) {
      throw new NotFoundException('Tournament not found');
    }

    // 2. Registered players may only join while OPEN.
    if (tournament.status !== 'OPEN') {
      throw new BadRequestException(
        'Tournament has already started — registration is closed',
      );
    }

    // 3. Check maxPlayers cap
    if (tournament.participants.length >= tournament.maxPlayers) {
      throw new BadRequestException(
        `Tournament is full (${tournament.maxPlayers} players max)`,
      );
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (tournament.isPrivate && user.isGuest) {
      throw new BadRequestException(
        'Private tournaments can only be joined by registered players',
      );
    }

    // 4. Prevent duplicate joins
    const alreadyJoined = tournament.participants.some(
      (p) => p.userId === userId,
    );

    if (alreadyJoined) {
      throw new ConflictException('You have already joined this tournament');
    }

    // 5. Re-check capacity and create the row inside one serializable
    // transaction. The check above is only a fast path for a friendly error: on
    // its own it is a read-then-write race, and two people taking the last slot
    // at the same moment would both pass it. Serializable makes the database
    // refuse the second one instead.
    const participant = await this.prisma
      .$transaction(
        async (tx) => {
          const seated = await tx.tournamentParticipant.count({
            where: { tournamentId },
          });
          if (seated >= tournament.maxPlayers) {
            throw new BadRequestException(
              `Tournament is full (${tournament.maxPlayers} players max)`,
            );
          }

          const created = await tx.tournamentParticipant.create({
            data: { tournamentId, userId },
            include: {
              user: {
                select: {
                  id: true,
                  username: true,
                  displayName: true,
                  email: true,
                },
              },
              tournament: {
                select: { id: true, name: true, maxPlayers: true },
              },
            },
          });

          await tx.tournamentParticipantStats.create({
            data: { participantId: created.id },
          });

          return created;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
      .catch((error: unknown) => {
        // A serialization failure means another join won the race for the same
        // slot. That is a conflict the caller can simply retry, not a server
        // fault, so it must not surface as a 500.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034'
        ) {
          throw new ConflictException(
            'Another player joined at the same moment. Please try again.',
          );
        }
        throw error;
      });

    await this.notifications.notify({
      userId,
      type: NotificationType.PARTICIPANT_ADDED,
      title: `You were added to ${tournament.name}`,
      link: `/tournaments/${tournamentId}/lobby`,
      tournamentId,
    });

    return participant;
  }

  async joinTournamentAsGuest(tournamentId: string, username: string) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: { participants: true },
    });

    if (!tournament) {
      throw new NotFoundException('Tournament not found');
    }

    // Guest registration is allowed while the field is OPEN and for historical
    // records after completion. It never reopens or mutates an ongoing bracket.
    const isOpen = tournament.status === 'OPEN';
    const isCompleted = tournament.status === 'COMPLETED';
    if (!isOpen && !isCompleted) {
      throw new BadRequestException(
        'Guest registration is available while registration is open or after the tournament is completed',
      );
    }

    // A completed tournament is being given a historical guest record, not a
    // bracket seat. Do not reject that record just because the original field
    // reached maxPlayers; the guest is not added to any match.
    if (isOpen && tournament.participants.length >= tournament.maxPlayers) {
      throw new BadRequestException(
        `Tournament is full (${tournament.maxPlayers} players max)`,
      );
    }

    if (isOpen && tournament.isPrivate) {
      throw new BadRequestException(
        'Private tournaments cannot be joined by guests',
      );
    }

    const now = new Date();
    const newExpiry = new Date(now);
    newExpiry.setDate(
      newExpiry.getDate() + TournamentService.GUEST_EXPIRY_DAYS,
    );
    // Keep post-completion guests on the tournament's existing cleanup window
    // when it is still active. If that window already passed, start a new one
    // so the new historical record has a complete retention period.
    const expiresAt = isCompleted && tournament.guestCleanupAt && tournament.guestCleanupAt > now
      ? tournament.guestCleanupAt
      : newExpiry;

    // One transaction for the same reason as joinTournament, plus a second: the
    // guest User row is created here. Without it, a failure between the two
    // writes would leave an orphaned guest account belonging to no tournament.
    return this.prisma
      .$transaction(
        async (tx) => {
          const seated = await tx.tournamentParticipant.count({
            where: { tournamentId },
          });
          if (isOpen && seated >= tournament.maxPlayers) {
            throw new BadRequestException(
              `Tournament is full (${tournament.maxPlayers} players max)`,
            );
          }

          const normalizedUsername = username.trim();
          const existingUser = await tx.user.findFirst({
            where: {
              username: { equals: normalizedUsername, mode: 'insensitive' },
            },
          });

          if (existingUser && !existingUser.isGuest) {
            throw new ConflictException(
              'That name belongs to a registered player. Use Invite Player instead.',
            );
          }

          const existingParticipant = existingUser
            ? await tx.tournamentParticipant.findUnique({
                where: {
                  userId_tournamentId: {
                    userId: existingUser.id,
                    tournamentId,
                  },
                },
                include: {
                  user: {
                    select: {
                      id: true,
                      username: true,
                      displayName: true,
                      email: true,
                    },
                  },
                  tournament: {
                    select: { id: true, name: true, maxPlayers: true },
                  },
                },
              })
            : null;
          if (existingParticipant) return existingParticipant;

          // No slug. A guest is a temporary row that the cleanup job deletes,
          // and a public profile handle for one is both useless and costly: it
          // takes a name out of the shared namespace ("swift-falcon") and keeps
          // it out after the account is gone. Guests are addressed by id, which
          // `GET /users/:handle/profile` resolves either way; `profileHref`
          // already falls back to it. The replace path below never generated
          // one, so this also makes the three guest-creation sites agree.
          const guestUser = existingUser ?? await tx.user.create({
            data: {
              isGuest: true,
              username: normalizedUsername,
              roles: ['PLAYER'],
              expiresAt,
            },
          });

          if (existingUser) {
            await tx.user.update({
              where: { id: existingUser.id },
              data: { expiresAt, isExpired: false },
            });
          }

          const participant = await tx.tournamentParticipant.create({
            data: { tournamentId, userId: guestUser.id },
            include: {
              user: {
                select: {
                  id: true,
                  username: true,
                  displayName: true,
                  email: true,
                },
              },
              tournament: {
                select: { id: true, name: true, maxPlayers: true },
              },
            },
          });

          await tx.tournamentParticipantStats.create({
            data: { participantId: participant.id },
          });

          if (isCompleted) {
            await tx.tournament.update({
              where: { id: tournamentId },
              data: { guestCleanupAt: expiresAt },
            });
          }

          return participant;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
      .catch((error: unknown) => {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034'
        ) {
          throw new ConflictException(
            'Another player joined at the same moment. Please try again.',
      );
  }

        throw error;
      });
  }

  /** Queue a registered player's invitation without occupying their roster
   * seat. Force-add continues to use joinTournament and bypasses this flow. */
  async inviteTournamentParticipant(tournamentId: string, userId: string, invitedById: string): Promise<void> {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: { participants: true },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');
    if (tournament.status !== 'OPEN') throw new BadRequestException('Tournament registration is closed');
    if (tournament.participants.length >= tournament.maxPlayers) throw new BadRequestException('Tournament is full');

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.isGuest) throw new NotFoundException('Registered player not found');
    if (tournament.participants.some((p) => p.userId === userId)) {
      throw new ConflictException('That player is already in this tournament');
    }

    const existing = await this.prisma.tournamentParticipantInvite.findUnique({
      where: { tournamentId_userId: { tournamentId, userId } },
    });
    if (existing?.status === ParticipantInviteStatus.PENDING) {
      throw new ConflictException('That player already has a pending invitation');
    }
    if (existing?.status === ParticipantInviteStatus.ACCEPTED) {
      throw new ConflictException('That player already accepted an invitation');
    }

    await this.prisma.tournamentParticipantInvite.upsert({
      where: { tournamentId_userId: { tournamentId, userId } },
      create: { tournamentId, userId, invitedById, status: ParticipantInviteStatus.PENDING },
      update: { invitedById, status: ParticipantInviteStatus.PENDING, respondedAt: null },
    });
    await this.notifications.notify({
      userId,
      type: NotificationType.PARTICIPANT_INVITED,
      title: `You were invited to join ${tournament.name}`,
      body: 'Open the tournament to accept or decline the invitation.',
      link: `/tournaments/${tournamentId}`,
      tournamentId,
    });
  }

  async listMyParticipantInvitations(userId: string) {
    return this.prisma.tournamentParticipantInvite.findMany({
      where: { userId, status: ParticipantInviteStatus.PENDING },
      orderBy: { createdAt: 'desc' },
      include: { tournament: { select: { id: true, name: true, status: true } } },
    });
  }

  async respondToParticipantInvitation(invitationId: string, userId: string, accept: boolean): Promise<void> {
    const invitation = await this.prisma.tournamentParticipantInvite.findUnique({
      where: { id: invitationId },
      include: { tournament: { select: { id: true, status: true, maxPlayers: true } } },
    });
    if (!invitation || invitation.userId !== userId) throw new NotFoundException('Invitation not found');
    if (invitation.status !== ParticipantInviteStatus.PENDING) {
      throw new BadRequestException('This invitation has already been answered');
    }
    if (!accept) {
      await this.prisma.tournamentParticipantInvite.update({
        where: { id: invitationId },
        data: { status: ParticipantInviteStatus.DECLINED, respondedAt: new Date() },
      });
      return;
    }
    if (invitation.tournament.status !== 'OPEN') throw new BadRequestException('Tournament registration is closed');

    await this.prisma.$transaction(async (tx) => {
      const seated = await tx.tournamentParticipant.count({ where: { tournamentId: invitation.tournamentId } });
      if (seated >= invitation.tournament.maxPlayers) throw new BadRequestException('Tournament is full');
      const alreadyJoined = await tx.tournamentParticipant.findUnique({
        where: { userId_tournamentId: { userId, tournamentId: invitation.tournamentId } },
      });
      if (alreadyJoined) throw new ConflictException('You are already in this tournament');
      const participant = await tx.tournamentParticipant.create({
        data: { tournamentId: invitation.tournamentId, userId },
      });
      await tx.tournamentParticipantStats.create({ data: { participantId: participant.id } });
      await tx.tournamentParticipantInvite.update({
        where: { id: invitationId },
        data: { status: ParticipantInviteStatus.ACCEPTED, respondedAt: new Date() },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    this.realtime.emitTournamentUpdated(invitation.tournamentId);
  }

  // ❌ LEAVE TOURNAMENT
  /** Removes a participant. F7: guests are an organizer-managed resource, so a
   *  guest can only be removed by tournament staff. A registered account may be
   *  removed by that account itself or by staff. (Previously guests were removable
   *  without any login — the walk-in desk is now run by an authenticated organizer.) */
  async leaveTournament(
    tournamentId: string,
    userId: string,
    requester?: JwtPayload,
  ) {
    // 1. Check tournament exists
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
    });

    if (!tournament) {
      throw new NotFoundException('Tournament not found');
    }

    // 2. Only allow leaving while OPEN
    if (tournament.status !== 'OPEN') {
      throw new BadRequestException(
        'Cannot leave a tournament that has already started',
      );
    }

    // 3. Check they are actually in it
    const participant = await this.prisma.tournamentParticipant.findUnique({
      where: {
        userId_tournamentId: { userId, tournamentId },
      },
      include: { user: { select: { isGuest: true } } },
    });

    if (!participant) {
      throw new NotFoundException(
        'You are not a participant in this tournament',
      );
    }

    // 3b. Anyone removed here is either removing themselves (a registered account)
    // or being removed by tournament staff. A guest can never be "self" (no token),
    // so guest removal is effectively staff-only — F7.
    const isSelf = requester?.id === userId;
    if (!isSelf) {
      const access = await checkTournamentAccess(
        this.prisma,
        tournamentId,
        requester,
      );
      if (access !== 'ALLOWED') {
        throw new ForbiddenException(
          'You do not have permission to remove this participant',
        );
      }
    }

    // 4. Remove them
    await this.prisma.tournamentParticipant.delete({
      where: {
        userId_tournamentId: { userId, tournamentId },
      },
    });

    // Only when somebody else removed them: a player who chose to leave does
    // not need telling that they left.
    if (requester?.id !== userId) {
      await this.notifications.notify({
        userId,
        type: NotificationType.PARTICIPANT_REMOVED,
        title: `You were removed from ${tournament.name}`,
        link: `/tournaments/${tournamentId}`,
        tournamentId,
      });
    }

    return { message: 'Successfully left the tournament' };
  }

  async getParticipants(tournamentId: string) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
    });

    if (!tournament) {
      throw new NotFoundException('Tournament not found');
    }

    return this.prisma.tournamentParticipant.findMany({
      where: { tournamentId },
      include: {
        user: {
          select: { id: true, username: true, displayName: true, email: true },
        },
      },
      orderBy: { seed: 'asc' },
    });
  }

  // 🌱 UPDATE PARTICIPANT SEED
  async updateSeed(tournamentId: string, userId: string, seed: number) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
    });

    if (!tournament) throw new NotFoundException('Tournament not found');

    if (tournament.status !== 'OPEN') {
      throw new BadRequestException(
        'Cannot change seeding after the tournament has started',
      );
    }

    const participant = await this.prisma.tournamentParticipant.findUnique({
      where: { userId_tournamentId: { userId, tournamentId } },
    });

    if (!participant) {
      throw new NotFoundException('Participant not found in this tournament');
    }

    return this.prisma.tournamentParticipant.update({
      where: { userId_tournamentId: { userId, tournamentId } },
      data: { seed },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            isGuest: true,
          },
        },
      },
    });
  }

  /** Removes a player from a live tournament. Marks them FORFEITED and awards
   *  every pending match they are in (with a determined opponent) to that
   *  opponent by walkover. Matches whose opponent is not yet known are left for
   *  MatchService.resolveForfeitedPairing to auto-resolve when the opponent
   *  arrives. Emits a realtime refresh so open views update immediately.
   *  Authorization is enforced by TournamentAccessGuard on the route
   *  (creator, ADMIN, or an accepted co-organizer) — see plan 9.3. */
  async forfeitParticipant(
    tournamentId: string,
    userId: string,
  ): Promise<void> {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');

    // Authorization is TournamentAccessGuard's job, and it already ran on this
    // route (@TournamentAccess('tournamentId')). It grants the creator, an
    // ADMIN, and an ACCEPTED co-organizer.
    //
    // Plan 9.3. A second `createdById || ADMIN` check used to sit here, and it
    // contradicted the guard: an accepted co-organizer passed the guard, saw
    // Forfeit and Replace because GET /tournaments/:id told them canManage was
    // true, and then got 403 on every attempt. CLAUDE.md is explicit that
    // co-organizers may manage participants and that only *staff* management
    // (inviting or revoking co-organizers) is creator-only — enforced separately
    // in OrganizerService, so staff still cannot recruit staff. Removed rather
    // than duplicated: two authorities disagreeing is what caused this.

    // Roster corrections only make sense on a live tournament. Without this a
    // forfeit could complete matches in an already-finished tournament, which
    // re-triggers checkTournamentComplete and re-awards lifetime points.
    if (tournament.status !== 'OPEN' && tournament.status !== 'ONGOING') {
      throw new BadRequestException(
        'Participants can only be managed while a tournament is open or ongoing',
      );
    }

    const participant = await this.prisma.tournamentParticipant.findUnique({
      where: { userId_tournamentId: { userId, tournamentId } },
    });
    if (!participant) throw new NotFoundException('Participant not found');
    if (participant.status === ParticipantStatus.FORFEITED) return;

    await this.prisma.tournamentParticipant.updateMany({
      where: { userId, tournamentId },
      data: { status: ParticipantStatus.FORFEITED },
    });

    const pending = await this.prisma.match.findMany({
      where: {
        round: { tournamentId },
        status: { not: MatchStatus.COMPLETED },
        OR: [{ player1Id: userId }, { player2Id: userId }],
      },
    });

    for (const m of pending) {
      const opponentId = m.player1Id === userId ? m.player2Id : m.player1Id;
      if (opponentId) {
        await this.matchService.completeAsWalkover(m.id, opponentId);
      }
    }

    await this.notifications.notify({
      userId,
      type: NotificationType.PARTICIPANT_FORFEITED,
      title: `You were forfeited from ${tournament.name}`,
      body: 'Your remaining matches were awarded to your opponents.',
      link: `/tournaments/${tournamentId}`,
      tournamentId,
    });

    this.realtime.emitTournamentUpdated(tournamentId);
  }

  /** Swaps a substitute into a player's slot. Only allowed while the player
   *  has zero completed matches, so no history is rewritten: the substitute
   *  inherits the seed and every pending (non-completed) match. Works for
   *  every format because it is a pure identity substitution rather than a
   *  bracket mutation. Authorization is enforced by TournamentAccessGuard on
   *  the route (creator, ADMIN, or an accepted co-organizer) — see plan 9.3.
   *  Emits a realtime refresh so open views update immediately. */
  async replaceParticipant(
    tournamentId: string,
    userId: string,
    dto: { substituteUserId?: string; guestName?: string },
  ): Promise<void> {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');

    // Authorization is TournamentAccessGuard's job, and it already ran on this
    // route (@TournamentAccess('tournamentId')). It grants the creator, an
    // ADMIN, and an ACCEPTED co-organizer.
    //
    // Plan 9.3. A second `createdById || ADMIN` check used to sit here, and it
    // contradicted the guard: an accepted co-organizer passed the guard, saw
    // Forfeit and Replace because GET /tournaments/:id told them canManage was
    // true, and then got 403 on every attempt. CLAUDE.md is explicit that
    // co-organizers may manage participants and that only *staff* management
    // (inviting or revoking co-organizers) is creator-only — enforced separately
    // in OrganizerService, so staff still cannot recruit staff. Removed rather
    // than duplicated: two authorities disagreeing is what caused this.

    // Roster corrections only make sense on a live tournament. Without this a
    // forfeit could complete matches in an already-finished tournament, which
    // re-triggers checkTournamentComplete and re-awards lifetime points.
    if (tournament.status !== 'OPEN' && tournament.status !== 'ONGOING') {
      throw new BadRequestException(
        'Participants can only be managed while a tournament is open or ongoing',
      );
    }

    const participant = await this.prisma.tournamentParticipant.findUnique({
      where: { userId_tournamentId: { userId, tournamentId } },
    });
    if (!participant) throw new NotFoundException('Participant not found');

    const completed = await this.prisma.match.count({
      where: {
        round: { tournamentId },
        status: MatchStatus.COMPLETED,
        OR: [{ player1Id: userId }, { player2Id: userId }],
      },
    });
    if (completed > 0) {
      throw new BadRequestException(
        'This player has already played a match and cannot be replaced; use forfeit instead',
      );
    }

    // Resolve who is taking the slot. Validation and lookups happen here, out of
    // the transaction; only the writes go inside it.
    let existingSubstituteId: string | null = null;
    let guestNameToCreate: string | null = null;
    let substituteName: string;
    if (dto.substituteUserId) {
      const existing = await this.prisma.tournamentParticipant.findUnique({
        where: {
          userId_tournamentId: {
            userId: dto.substituteUserId,
            tournamentId,
          },
        },
      });
      if (existing) {
        throw new BadRequestException(
          'That user is already a participant in this tournament',
        );
      }

      const substitute = await this.prisma.user.findUnique({
        where: { id: dto.substituteUserId },
      });
      if (!substitute) throw new NotFoundException('Substitute user not found');

      existingSubstituteId = substitute.id;
      substituteName = substitute.username ?? 'Player';
    } else if (dto.guestName) {
      substituteName = dto.guestName;
      guestNameToCreate = dto.guestName;
    } else {
      throw new BadRequestException(
        'Provide either substituteUserId or guestName',
      );
    }

    // One transaction: the slot and every match that referenced the old player
    // must move together, or a half-applied swap leaves matches naming someone
    // who is no longer in the tournament. Creating the guest is included for the
    // same reason it is in joinTournamentAsGuest - a failure after the create
    // would otherwise leave an account belonging to nothing.
    await this.prisma.$transaction(async (tx) => {
      let substituteId = existingSubstituteId;

      if (!substituteId && guestNameToCreate) {
        // Match joinTournamentAsGuest's guest-creation shape exactly: guests
        // have no dedicated display-name field, only `username`.
        const expiresAt = new Date();
        expiresAt.setDate(
          expiresAt.getDate() + TournamentService.GUEST_EXPIRY_DAYS,
        );

        const guest = await tx.user.create({
          data: {
            isGuest: true,
            username: guestNameToCreate,
            roles: ['PLAYER'],
            expiresAt,
          },
        });
        substituteId = guest.id;
      }

      await tx.tournamentParticipant.update({
        where: { id: participant.id },
        data: { userId: substituteId as string },
      });

      await tx.match.updateMany({
        where: {
          round: { tournamentId },
          status: { not: MatchStatus.COMPLETED },
          player1Id: userId,
        },
        data: { player1Id: substituteId, p1Name: substituteName },
      });
      await tx.match.updateMany({
        where: {
          round: { tournamentId },
          status: { not: MatchStatus.COMPLETED },
          player2Id: userId,
        },
        data: { player2Id: substituteId, p2Name: substituteName },
      });
    });

    // Emitted only after the swap has committed: a socket message cannot be
    // recalled if the transaction rolls back.
    this.realtime.emitTournamentUpdated(tournamentId);
  }
}
