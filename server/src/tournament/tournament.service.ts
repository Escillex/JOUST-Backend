import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { FormatsService } from 'src/Formats/formats.service';
import { CreateTournamentDto, UpdateTournamentDto } from './dto/tournament.dto';
import { Tournament, TournamentStatus, MatchStatus, TournamentFormat } from '@prisma/client';

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

    const formatConfig = this.applyBaseRules(dto.format, dto.formatConfig);

    const status = dto.startNow ? TournamentStatus.OPEN : TournamentStatus.UPCOMING;

    return this.prisma.tournament.create({
      data: {
        name: dto.name,
        format: dto.format,
        maxPlayers: dto.maxPlayers,
        prizePool: dto.prizePool,
        entranceFee: dto.entranceFee,
        venue: dto.venue,
        date: dto.date ? new Date(dto.date) : undefined,
        isPrivate: dto.isPrivate,
        status: status,
        createdById: dto.createdById,
        ...(formatConfig && {
          formatConfig: {
            create: formatConfig,
          },
        }),
      },
      include: {
        createdBy: {
          select: { id: true, username: true, roles: true, email: true },
        },
        formatConfig: {
          select: {
            winsToAdvance: true,
            swissRounds: true,
            swissPointsForWin: true,
            swissPointsForDraw: true,
            swissPointsForLoss: true,
            pointsThreshold: true,
            sessionsCount: true,
            pointsPerSession: true,
          },
        },
      },
    });
  }

  private applyBaseRules(format: TournamentFormat, config?: any) {
    const baseRules: any = { ...config };
    if (
      format === TournamentFormat.SINGLE_ELIMINATION ||
      format === TournamentFormat.DOUBLE_ELIMINATION ||
      format === TournamentFormat.ROUND_ROBIN
    ) {
      if (baseRules.winsToAdvance === undefined) baseRules.winsToAdvance = 1;
    }
    if (format === TournamentFormat.SWISS) {
      if (baseRules.swissPointsForWin === undefined)
        baseRules.swissPointsForWin = 3;
      if (baseRules.swissPointsForDraw === undefined)
        baseRules.swissPointsForDraw = 1;
      if (baseRules.swissPointsForLoss === undefined)
        baseRules.swissPointsForLoss = 0;
    }
    return Object.keys(baseRules).length > 0 ? baseRules : undefined;
  }

  async updateTournament(id: string, dto: UpdateTournamentDto) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');
    if (tournament.status !== TournamentStatus.OPEN)
      throw new BadRequestException('Cannot edit started tournament');

    const { formatConfig, createdById, date, ...rest } = dto;

    return this.prisma.tournament.update({
      where: { id },
      data: {
        ...rest,
        ...(date !== undefined && { date: date ? new Date(date) : null }),
        ...(formatConfig && {
          formatConfig: {
            upsert: {
              create: formatConfig,
              update: formatConfig,
            },
          },
        }),
      },
      include: {
        formatConfig: {
          select: {
            winsToAdvance: true,
            swissRounds: true,
            swissPointsForWin: true,
            swissPointsForDraw: true,
            swissPointsForLoss: true,
            pointsThreshold: true,
            sessionsCount: true,
            pointsPerSession: true,
          },
        },
      },
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

    const existingRounds = await this.prisma.round.count({
      where: { tournamentId },
    });
    if (existingRounds > 0)
      throw new BadRequestException('Tournament has already been initialized');

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
      },
    });

    if (!tournament) throw new NotFoundException('Tournament not found');

    const winnerId = tournament.winnerId;

    const guestUserIds = tournament.participants
      .filter((p) => p.user.isGuest && p.user.id !== winnerId)
      .map((p) => p.user.id);

    if (tournament.status !== TournamentStatus.COMPLETED) {
      await this.prisma.tournament.update({
        where: { id: tournamentId },
        data: { status: TournamentStatus.COMPLETED },
      });
    }

    if (guestUserIds.length > 0) {
      await this.prisma.tournamentParticipant.deleteMany({
        where: { userId: { in: guestUserIds } },
      });

      await this.prisma.user.deleteMany({
        where: {
          id: { in: guestUserIds },
          isGuest: true,
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
        winner: {
          select: { id: true, username: true, guestName: true, isGuest: true },
        },
        formatConfig: {
          select: {
            winsToAdvance: true,
            swissRounds: true,
            swissPointsForWin: true,
            swissPointsForDraw: true,
            swissPointsForLoss: true,
            pointsThreshold: true,
            sessionsCount: true,
            pointsPerSession: true,
          },
        },
        participants: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                email: true,
                guestName: true,
                isGuest: true,
              },
            },
          },
        },
        rounds: {
          orderBy: { roundNumber: 'asc' },
          include: {
            matches: {
              include: {
                player1: {
                  select: {
                    id: true,
                    username: true,
                    guestName: true,
                    isGuest: true,
                  },
                },
                player2: {
                  select: {
                    id: true,
                    username: true,
                    guestName: true,
                    isGuest: true,
                  },
                },
                winner: {
                  select: {
                    id: true,
                    username: true,
                    guestName: true,
                    isGuest: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');
    return tournament;
  }

  async getTournamentByInviteToken(inviteToken: string) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { inviteToken },
      include: {
        createdBy: { select: { id: true, username: true, email: true } },
        winner: {
          select: { id: true, username: true, guestName: true, isGuest: true },
        },
        formatConfig: {
          select: {
            winsToAdvance: true,
            swissRounds: true,
            swissPointsForWin: true,
            swissPointsForDraw: true,
            swissPointsForLoss: true,
            pointsThreshold: true,
            sessionsCount: true,
            pointsPerSession: true,
          },
        },
        participants: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                email: true,
                guestName: true,
                isGuest: true,
              },
            },
          },
        },
        rounds: {
          orderBy: { roundNumber: 'asc' },
          include: {
            matches: {
              include: {
                player1: {
                  select: {
                    id: true,
                    username: true,
                    guestName: true,
                    isGuest: true,
                  },
                },
                player2: {
                  select: {
                    id: true,
                    username: true,
                    guestName: true,
                    isGuest: true,
                  },
                },
                winner: {
                  select: {
                    id: true,
                    username: true,
                    guestName: true,
                    isGuest: true,
                  },
                },
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
    // Auto-open scheduled tournaments
    await this.prisma.tournament.updateMany({
      where: {
        status: TournamentStatus.UPCOMING,
        date: {
          lte: new Date(),
        },
      },
      data: {
        status: TournamentStatus.OPEN,
      },
    });

    return this.prisma.tournament.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        winner: { select: { username: true, guestName: true, isGuest: true } },
        rounds: {
          orderBy: { roundNumber: 'desc' },
          take: 1,
          include: {
            matches: {
              include: {
                winner: {
                  select: { username: true, guestName: true, isGuest: true },
                },
              },
            },
          },
        },
      },
    });
  }
}
