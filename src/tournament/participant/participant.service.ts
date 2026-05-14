import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { TournamentService } from '../tournament.service';

@Injectable()
export class ParticipantService {
  constructor(private prisma: PrismaService) {}

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

    // 2. Only allow joining while OPEN
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

    // 5. Create participant record
    const participant = await this.prisma.tournamentParticipant.create({
      data: {
        tournamentId,
        userId,
      },
      include: {
        user: {
          select: { id: true, username: true, email: true },
        },
        tournament: {
          select: { id: true, name: true, maxPlayers: true },
        },
      },
    });

    await this.prisma.tournamentParticipantStats.create({
      data: { participantId: participant.id },
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

    if (tournament.status !== 'OPEN') {
      throw new BadRequestException(
        'Tournament has already started — registration is closed',
      );
    }

    if (tournament.participants.length >= tournament.maxPlayers) {
      throw new BadRequestException(
        `Tournament is full (${tournament.maxPlayers} players max)`,
      );
    }

    if (tournament.isPrivate) {
      throw new BadRequestException(
        'Private tournaments cannot be joined by guests',
      );
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + TournamentService.GUEST_EXPIRY_DAYS);

    const guestUser = await this.prisma.user.create({
      data: {
        isGuest: true,
        username,
        roles: ['PLAYER'],
        expiresAt,
      },
    });

    const participant = await this.prisma.tournamentParticipant.create({
      data: {
        tournamentId,
        userId: guestUser.id,
      },
      include: {
        user: {
          select: { id: true, username: true, email: true },
        },
        tournament: {
          select: { id: true, name: true, maxPlayers: true },
        },
      },
    });

    await this.prisma.tournamentParticipantStats.create({
      data: { participantId: participant.id },
    });

    return participant;
  }

  // ❌ LEAVE TOURNAMENT
  async leaveTournament(tournamentId: string, userId: string) {
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
    });

    if (!participant) {
      throw new NotFoundException(
        'You are not a participant in this tournament',
      );
    }

    // 4. Remove them
    await this.prisma.tournamentParticipant.delete({
      where: {
        userId_tournamentId: { userId, tournamentId },
      },
    });

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
          select: { id: true, username: true, email: true },
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
        user: { select: { id: true, username: true, isGuest: true } },
      },
    });
  }
}

