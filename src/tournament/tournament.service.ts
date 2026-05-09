import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { FormatsService } from 'src/Formats/formats.service';
import {
  CreateTournamentDto,
  UpdateTournamentDto,
  TournamentStatusDto,
} from './dto/tournament.dto';
import {
  Tournament,
  TournamentStatus,
  MatchStatus,
  TournamentFormat,
  Role,
} from '@prisma/client';
import { JwtPayload } from 'src/guards/jwt-auth.guard';

@Injectable()
export class TournamentService {
  public static GUEST_EXPIRY_DAYS = 30;

  private readonly ALLOWED_TRANSITIONS: Record<
    TournamentStatus,
    TournamentStatus[]
  > = {
      [TournamentStatus.UPCOMING]: [TournamentStatus.OPEN],
      [TournamentStatus.PENDING]: [TournamentStatus.OPEN],
      [TournamentStatus.OPEN]: [TournamentStatus.ONGOING],
      [TournamentStatus.ONGOING]: [TournamentStatus.COMPLETED],
      [TournamentStatus.COMPLETED]: [],
    };

  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => FormatsService))
    private formatsService: FormatsService,
  ) { }

  async updateStatus(
    tournamentId: string,
    dto: TournamentStatusDto,
    user: JwtPayload,
  ) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
    });

    if (!tournament) throw new NotFoundException('Tournament not found');

    if (
      tournament.createdById !== user.id &&
      !user.roles.includes(Role.ADMIN)
    ) {
      throw new ForbiddenException(
        'Only the tournament organizer can update the status',
      );
    }

    const currentStatus = tournament.status;
    const targetStatus = dto.status;

    if (!this.ALLOWED_TRANSITIONS[currentStatus].includes(targetStatus)) {
      throw new BadRequestException(
        `Invalid status transition from ${currentStatus} to ${targetStatus}`,
      );
    }

    return this.prisma.tournament.update({
      where: { id: tournamentId },
      data: { status: targetStatus },
    });
  }

  async updateStatusInternal(
    tournamentId: string,
    targetStatus: TournamentStatus,
  ) {
    return this.prisma.tournament.update({
      where: { id: tournamentId },
      data: { status: targetStatus },
    });
  }

  async createTournament(dto: CreateTournamentDto) {
    const existing = await this.prisma.tournament.findFirst({
      where: { name: dto.name, createdById: dto.createdById },
    });
    if (existing) throw new BadRequestException('Tournament name exists');

    const formatConfig = this.normalizeFormatConfig(
      this.applyBaseRules(dto.format, dto.formatConfig),
    );

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
        ...(dto.cardGameId && { cardGameId: dto.cardGameId }),
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
            bestOf: true,
            allowDraw: true,
            tieBreakerOrder: true,
            progressionType: true,
          },
        },
        cardGame: {
          select: {
            id: true,
            name: true,
            description: true,
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

  private normalizeFormatConfig(config?: any) {
    if (!config) return undefined;

    const normalized = Object.entries(config).reduce((acc, [key, value]) => {
      if (value === null || value === undefined) return acc;
      acc[key] = value;
      return acc;
    }, {} as Record<string, unknown>);

    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  async generateBracket(tournamentId: string, user: JwtPayload) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                isGuest: true,
              },
            },
          },
          orderBy: [{ seed: 'asc' }, { id: 'asc' }],
        },
      },
    });

    if (!tournament) throw new BadRequestException('Tournament not found');
    if (tournament.status !== TournamentStatus.PENDING && tournament.status !== TournamentStatus.OPEN && tournament.status !== TournamentStatus.UPCOMING)
      throw new BadRequestException(
        'Tournament must be PENDING, UPCOMING, or OPEN to generate bracket',
      );
    if (tournament.participants.length < 2)
      throw new BadRequestException('Need at least 2 players');

    if (tournament.createdById !== user.id && !user.roles.includes(Role.ADMIN)) {
      throw new ForbiddenException(
        'Only the tournament organizer can generate the bracket',
      );
    }

    const participants = tournament.participants
      .filter((p) => p.user)
      .map((p) => ({
        id: p.user.id,
        name: p.user.username,
      }));

    const bracketSize = this.nextPowerOfTwo(participants.length);
    const matchups: {
      matchIndex: number;
      player1: (typeof participants)[0] | null;
      player2: (typeof participants)[0] | null;
    }[] = [];

    for (let i = 0; i < bracketSize / 2; i++) {
      const p1 = participants[i * 2] || null;
      const p2 = participants[i * 2 + 1] || null;

      matchups.push({
        matchIndex: i + 1,
        player1: p1,
        player2: p2,
      });
    }

    return matchups;
  }

  private nextPowerOfTwo(n: number): number {
    let power = 1;
    while (power < n) power *= 2;
    return power;
  }

  async updateTournament(id: string, dto: UpdateTournamentDto) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');
    if (tournament.status !== TournamentStatus.OPEN)
      throw new BadRequestException('Cannot edit started tournament');

    const { formatConfig: rawFormatConfig, createdById, date, ...rest } = dto;
    const format = dto.format ?? tournament.format;
    const formatConfig = this.normalizeFormatConfig(
      this.applyBaseRules(format, rawFormatConfig),
    );

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
            bestOf: true,
            allowDraw: true,
            tieBreakerOrder: true,
            progressionType: true,
          },
        },
      },
    });
  }

  async startTournament(tournamentId: string) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: {
        participants: true,
        rounds: {
          where: { roundNumber: 1 },
          include: { matches: true },
        },
      },
    });

    if (!tournament) throw new NotFoundException('Tournament not found');
    if (tournament.status !== TournamentStatus.OPEN)
      throw new BadRequestException('Tournament already started');
    if (tournament.participants.length < 2)
      throw new BadRequestException('Need at least 2 players');

    const firstRound = tournament.rounds[0];

    if (!firstRound) {
      // If bracket wasn't pre-generated/locked, generate it now
      const playerIds = tournament.participants.map((p) => p.userId);
      await this.formatsService.initializeTournamentFormat(
        tournamentId,
        tournament.format,
        playerIds,
        false, // don't activate yet, we do it below
      );

      // Re-fetch to get the newly created rounds
      const updatedTournament = await this.prisma.tournament.findUnique({
        where: { id: tournamentId },
        include: {
          rounds: {
            where: { roundNumber: 1 },
            include: { matches: true },
          },
        },
      });

      const newFirstRound = updatedTournament?.rounds[0];
      if (!newFirstRound) {
        throw new BadRequestException('Failed to generate bracket');
      }

      // Activate matches in the first round
      for (const match of newFirstRound.matches) {
        if (match.player1Id && match.player2Id) {
          await this.prisma.match.update({
            where: { id: match.id },
            data: { status: MatchStatus.ONGOING },
          });
        } else if (match.isBye && (match.player1Id || match.player2Id)) {
          const winnerId = (match.player1Id || match.player2Id) as string;
          await this.prisma.match.update({
            where: { id: match.id },
            data: {
              winnerId: winnerId,
              status: MatchStatus.COMPLETED,
            },
          });
          await this.formatsService.handleMatchCompletion(match.id);
        }
      }
    } else {
      // Activate pre-generated first round matches
      for (const match of firstRound.matches) {
        if (match.player1Id && match.player2Id) {
          await this.prisma.match.update({
            where: { id: match.id },
            data: { status: MatchStatus.ONGOING },
          });
        } else if (match.isBye && (match.player1Id || match.player2Id)) {
          const winnerId = (match.player1Id || match.player2Id) as string;
          await this.prisma.match.update({
            where: { id: match.id },
            data: {
              winnerId: winnerId,
              status: MatchStatus.COMPLETED,
            },
          });
          // Handle progression for bye
          await this.formatsService.handleMatchCompletion(match.id);
        }
      }
    }

    await this.updateStatusInternal(tournamentId, TournamentStatus.ONGOING);

    return { message: 'Tournament started successfully' };
  }

  async completeTournament(tournamentId: string) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: {
        participants: { include: { user: true } },
        rounds: {
          include: {
            matches: {
              include: {
                player1: true,
                player2: true,
                winner: true,
              }
            }
          }
        }
      },
    });

    if (!tournament) throw new NotFoundException('Tournament not found');

    const winnerId = tournament.winnerId;

    const guestUserIds = tournament.participants
      .filter((p) => p.user.isGuest && p.user.id !== winnerId)
      .map((p) => p.user.id);

    if (tournament.status !== TournamentStatus.COMPLETED) {
      await this.updateStatusInternal(tournamentId, TournamentStatus.COMPLETED);
    }

    // Snapshot names for all matches before guest purge (Immediate)
    for (const round of tournament.rounds) {
      for (const match of round.matches) {
        await this.prisma.match.update({
          where: { id: match.id },
          data: {
            p1Name: match.player1?.username || match.p1Name,
            p2Name: match.player2?.username || match.p2Name,
            winnerName: match.winner?.username || match.winnerName,
          }
        });
      }
    }

    // Snapshot tournament winner name
    if (winnerId) {
      const winner = tournament.participants.find(p => p.userId === winnerId)?.user;
      await this.prisma.tournament.update({
        where: { id: tournamentId },
        data: { winnerName: winner?.username || "Unknown Champion" } as any,
      });
    }

    // Set cleanup timestamp
    const cleanupTime = new Date();
    cleanupTime.setDate(cleanupTime.getDate() + TournamentService.GUEST_EXPIRY_DAYS);
    await this.prisma.tournament.update({
      where: { id: tournamentId },
      data: { guestCleanupAt: cleanupTime },
    });

    // Also update the individual guests to expire in 10 seconds
    if (guestUserIds.length > 0) {
      await this.prisma.user.updateMany({
        where: {
          id: { in: guestUserIds },
          isGuest: true,
        },
        data: {
          expiresAt: cleanupTime,
          isExpired: false,
        }
      });
    }

    return { message: 'Tournament data cleaned up. Winner preserved.' };
  }

  async cancelCleanup(tournamentId: string) {
    return this.prisma.tournament.update({
      where: { id: tournamentId },
      data: { guestCleanupAt: null },
    });
  }

  async getTournament(tournamentId: string) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: {
        createdBy: { select: { id: true, username: true, email: true } },
        winner: {
          select: { id: true, username: true, isGuest: true },
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
            bestOf: true,
            allowDraw: true,
            tieBreakerOrder: true,
            progressionType: true,
          },
        },
        cardGame: {
          select: {
            id: true,
            name: true,
            description: true,
          },
        },
        participants: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                email: true,
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
                    isGuest: true,
                  },
                },
                player2: {
                  select: {
                    id: true,
                    username: true,
                    isGuest: true,
                  },
                },
                winner: {
                  select: {
                    id: true,
                    username: true,
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
          select: { id: true, username: true, isGuest: true },
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
            bestOf: true,
            allowDraw: true,
            tieBreakerOrder: true,
            progressionType: true,
          },
        },
        cardGame: {
          select: {
            id: true,
            name: true,
            description: true,
          },
        },
        participants: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                email: true,
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
                    isGuest: true,
                  },
                },
                player2: {
                  select: {
                    id: true,
                    username: true,
                    isGuest: true,
                  },
                },
                winner: {
                  select: {
                    id: true,
                    username: true,
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
    // 1. Auto-purge expired guests on access
    const now = new Date();
    const expired = await this.prisma.user.findMany({
      where: {
        isGuest: true,
        OR: [
          { isExpired: true },
          { expiresAt: { lte: now } }
        ]
      },
      select: { id: true }
    });

    // We can't easily call authService.deleteUser here without circular dependency
    // but we can at least mark them so they don't show up
    if (expired.length > 0) {
      await this.prisma.user.updateMany({
        where: { id: { in: expired.map(u => u.id) } },
        data: { isExpired: true }
      });
    }

    // 2. Auto-open scheduled tournaments
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
        winner: { select: { username: true, isGuest: true } },
        cardGame: {
          select: { id: true, name: true, description: true },
        },
        rounds: {
          orderBy: { roundNumber: 'desc' },
          take: 1,
          include: {
            matches: {
              include: {
                winner: {
                  select: { username: true, isGuest: true },
                },
              },
            },
          },
        },
      },
    });
  }
}
