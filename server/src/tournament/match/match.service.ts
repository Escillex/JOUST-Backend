import {
  Injectable,
  BadRequestException,
  NotFoundException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { FormatsService } from '../../Formats/formats.service';
import { MatchStatus } from '@prisma/client';

@Injectable()
export class MatchService {
  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => FormatsService))
    private formatsService: FormatsService,
  ) {}

  async createMatch(dto: {
    roundId: string;
    player1Id?: string;
    player2Id?: string;
    isBye: boolean;
  }) {
    return this.prisma.match.create({
      data: {
        roundId: dto.roundId,
        player1Id: dto.player1Id ?? null,
        player2Id: dto.player2Id ?? null,
        isBye: dto.isBye,
      },
    });
  }

  async linkMatches(previousIds: string[], nextIds: string[]) {
    for (let i = 0; i < previousIds.length; i++) {
      const nextMatchId = nextIds[Math.floor(i / 2)];
      await this.prisma.match.update({
        where: { id: previousIds[i] },
        data: { nextMatchId },
      });
    }
  }

  async submitResult(matchId: string, winnerId?: string) {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: { round: { include: { tournament: true } } },
    });

    if (!match) throw new NotFoundException('Match not found');
    if (match.status === MatchStatus.COMPLETED)
      throw new BadRequestException('Match already completed');
    if (match.status === MatchStatus.PENDING)
      throw new BadRequestException('Match not started');

    if (winnerId) {
      const validPlayers = [match.player1Id, match.player2Id].filter(Boolean);
      if (!validPlayers.includes(winnerId))
        throw new BadRequestException('Winner must be in match');
    }

    const completed = await this.prisma.match.update({
      where: { id: matchId },
      data: { winnerId: winnerId || null, status: MatchStatus.COMPLETED },
    });

    // Delegate format-specific logic (advancement or next round pairing)
    await this.formatsService.handleMatchCompletion(matchId);

    return { message: 'Result submitted', match: completed };
  }

  async advanceWinner(winnerId: string, nextMatchId: string) {
    const nextMatch = await this.prisma.match.findUnique({
      where: { id: nextMatchId },
    });
    if (!nextMatch) return;

    const slot = nextMatch.player1Id === null ? 'player1Id' : 'player2Id';
    const updated = await this.prisma.match.update({
      where: { id: nextMatchId },
      data: { [slot]: winnerId },
    });

    if (updated.player1Id && updated.player2Id) {
      await this.activateMatch(nextMatchId);
    }
  }

  async activateMatch(matchId: string) {
    return this.prisma.match.update({
      where: { id: matchId },
      data: { status: MatchStatus.ONGOING },
    });
  }

  async getMatch(matchId: string) {
    return this.prisma.match.findUnique({
      where: { id: matchId },
      include: {
        player1: { select: { id: true, username: true } },
        player2: { select: { id: true, username: true } },
        winner: { select: { id: true, username: true } },
      },
    });
  }

  async getMatchesByRound(roundId: string) {
    return this.prisma.match.findMany({
      where: { roundId },
      include: {
        player1: { select: { id: true, username: true } },
        player2: { select: { id: true, username: true } },
        winner: { select: { id: true, username: true } },
      },
    });
  }
}
