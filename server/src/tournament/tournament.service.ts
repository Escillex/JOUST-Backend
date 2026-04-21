import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { FormatsService } from 'src/Formats/formats.service';
import { CreateTournamentDto, UpdateTournamentDto } from './dto/tournament.dto';
import { Tournament, TournamentStatus, MatchStatus } from '@prisma/client';

@Injectable()
export class TournamentService {
  constructor(
    private prisma: PrismaService,
    private formatsService: FormatsService,
  ) {}

  async createTournament(dto: CreateTournamentDto) {
    const existing = await this.prisma.tournament.findFirst({
      where: { name: dto.name, createdById: dto.createdById },
    });
    if (existing) throw new BadRequestException('Tournament name exists');

    return this.prisma.tournament.create({
      data: {
        name: dto.name,
        format: dto.format,
        maxPlayers: dto.maxPlayers,
        prizePool: dto.prizePool,
        isPrivate: dto.isPrivate,
        createdById: dto.createdById,
      },
      include: {
        createdBy: {
          select: { id: true, username: true, roles: true, email: true },
        },
      },
    });
  }

  async updateTournament(id: string, dto: UpdateTournamentDto) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');
    if (tournament.status !== TournamentStatus.OPEN)
      throw new BadRequestException('Cannot edit started tournament');

    const updateData = { ...dto };
    delete updateData.createdById;
    return this.prisma.tournament.update({
      where: { id },
      data: updateData,
    });
  }

  async startTournament(tournamentId: string) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: { participants: true },
    });

    if (!tournament) throw new NotFoundException('Tournament not found');
    if (tournament.status !== TournamentStatus.OPEN)
      throw new BadRequestException('Tournament already started');
    if (tournament.participants.length < 2)
      throw new BadRequestException('Need at least 2 players');

    const participants = tournament.participants.map((p) => p.userId);
    const shuffled = this.shuffle(participants);

    await this.formatsService.initializeTournamentFormat(
      tournamentId,
      tournament.format,
      shuffled,
    );

    await this.prisma.tournament.update({
      where: { id: tournamentId },
      data: { status: TournamentStatus.ONGOING },
    });

    return { message: 'Tournament started successfully' };
  }

  private shuffle(array: string[]): string[] {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  async completeTournament(tournamentId: string) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: {
        participants: {
          include: {
            user: true,
          },
        },
        rounds: {
          orderBy: { roundNumber: 'desc' },
          take: 1,
          include: {
            matches: {
              where: { status: MatchStatus.COMPLETED }, // Fixed enum here
              include: { winner: true }
            }
          }
        }
      },
    });
  
    if (!tournament) throw new NotFoundException('Tournament not found');
    
    // Find the overall winner to exclude from deletion
    let winnerId: string | null = null;
    if (tournament.rounds.length > 0 && tournament.rounds[0].matches.length > 0) {
      // In single elim, last round has 1 match with the champion
      winnerId = tournament.rounds[0].matches[0].winnerId;
    }
  
    // 1. Get guest user IDs from this tournament only, excluding the winner
    const guestUserIds = tournament.participants
      .filter((p) => p.user.email.startsWith('guest_') && p.user.id !== winnerId)
      .map((p) => p.user.id);
  
    // 2. Mark tournament as completed (if not already)
    if (tournament.status !== TournamentStatus.COMPLETED) {
      await this.prisma.tournament.update({
        where: { id: tournamentId },
        data: { status: TournamentStatus.COMPLETED },
      });
    }
  
    if (guestUserIds.length > 0) {
      // 3. Delete their TournamentParticipant records first (foreign key safety)
      await this.prisma.tournamentParticipant.deleteMany({
        where: { userId: { in: guestUserIds } },
      });
  
      // 4. Delete the guest users themselves
      await this.prisma.user.deleteMany({
        where: {
          id: { in: guestUserIds },
          email: { startsWith: 'guest_' }, // double safety check
        },
      });
    }
  
    return { message: 'Tournament data cleaned up. Winner preserved.' };
  }

  async getTournament(tournamentId: string) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: {
        createdBy: { select: { id: true, username: true, email: true } },
        participants: {
          include: {
            user: { select: { id: true, username: true, email: true } },
          },
        },
        rounds: {
          orderBy: { roundNumber: 'asc' },
          include: {
            matches: {
              include: {
                player1: { select: { id: true, username: true } },
                player2: { select: { id: true, username: true } },
                winner: { select: { id: true, username: true } },
              },
            },
          },
        },
      },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');
    return tournament;
  }

  async getAllTournaments(): Promise<Tournament[]> {
    return this.prisma.tournament.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        rounds: {
          orderBy: { roundNumber: 'desc' },
          take: 1,
          include: {
            matches: {
              include: {
                winner: { select: { username: true } },
              },
            },
          },
        },
      },
    });
  }
}
