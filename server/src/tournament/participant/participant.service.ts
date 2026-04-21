import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { JoinTournamentDto } from './dto/participant.dto';
@Injectable()
export class ParticipantService {
  constructor(private prisma: PrismaService) {}

  // ✅ JOIN TOURNAMENT
  async joinTournament(tournamentId: string, dto: JoinTournamentDto) {
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

    // 4. Prevent duplicate joins
    const alreadyJoined = tournament.participants.some(
      (p) => p.userId === dto.userId,
    );

    if (alreadyJoined) {
      throw new ConflictException('You have already joined this tournament');
    }

    // 5. Create participant record
    return this.prisma.tournamentParticipant.create({
      data: {
        tournamentId,
        userId: dto.userId,
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

  // 📋 FETCH ALL PARTICIPANTS
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
}
