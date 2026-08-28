import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { MatchStatus } from '@prisma/client';

export interface UserStats {
  userId: string;
  wins: number;
  losses: number;
  winRate: number;
  tournamentsPlayed: number;
  rank: number | null;
}

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  async getUserStats(userId: string): Promise<UserStats> {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(userId)) {
      throw new BadRequestException('Invalid user ID format');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Wins and losses. Byes are excluded (F14): a bye sets winnerId but is not a
    // played game, and counting it as a win inflates the record — the losses query
    // below already excludes byes, so wins must too.
    const wins = await this.prisma.match.count({
      where: {
        winnerId: userId,
        status: MatchStatus.COMPLETED,
        NOT: { isBye: true },
      },
    });

    const losses = await this.prisma.match.count({
      where: {
        status: MatchStatus.COMPLETED,
        OR: [
          { player1Id: userId, NOT: { winnerId: userId } },
          { player2Id: userId, NOT: { winnerId: userId } },
        ],
        NOT: { isBye: true },
      },
    });

    const winRate = wins + losses === 0 ? 0 : wins / (wins + losses);

    // Tournaments played
    const tournamentsPlayed = await this.prisma.tournamentParticipant.count({
      where: { userId },
    });

    // Rank computation
    // "order users by wins DESC, assign rank 1 to highest. Return null if user has 0 matches."
    let rank: number | null = null;

    if (wins + losses > 0) {
      // Optimization: Count how many unique users have more wins than this user
      // This is a simplified ranking as per requirements (by wins DESC)

      // Since Prisma doesn't have a direct "rank" window function in a simple way without raw SQL,
      // we can use a group by or count unique users with more wins.

      const usersWithMoreWins = await this.prisma.match.groupBy({
        by: ['winnerId'],
        where: {
          winnerId: { not: null },
          status: MatchStatus.COMPLETED,
          // Same as the win count above (F14): byes are not real wins, so they
          // must not inflate anyone's total in the ranking comparison either.
          NOT: { isBye: true },
        },
        _count: {
          winnerId: true,
        },
        having: {
          winnerId: {
            _count: {
              gt: wins,
            },
          },
        },
      });

      rank = usersWithMoreWins.length + 1;
    }

    return {
      userId,
      wins,
      losses,
      winRate,
      tournamentsPlayed,
      rank,
    };
  }

  async getUserMatches(userId: string) {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(userId)) {
      throw new BadRequestException('Invalid user ID format');
    }

    const matches = await this.prisma.match.findMany({
      where: {
        status: MatchStatus.COMPLETED,
        OR: [{ player1Id: userId }, { player2Id: userId }],
        NOT: { isBye: true },
      },
      include: {
        round: { include: { tournament: true } },
        player1: { select: { id: true, username: true, avatarUrl: true } },
        player2: { select: { id: true, username: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 15,
    });

    return matches.map((match) => {
      let type = 'entry';
      if (match.winnerId === userId) {
        type = 'win';
      } else if (match.winnerId === null) {
        type = 'draw';
      } else {
        type = 'loss';
      }

      const isPlayer1 = match.player1Id === userId;
      const opponent = isPlayer1
        ? match.player2?.username || match.p2Name || 'TBD'
        : match.player1?.username || match.p1Name || 'TBD';

      const myScore = isPlayer1 ? match.player1Score : match.player2Score;
      const oppScore = isPlayer1 ? match.player2Score : match.player1Score;

      return {
        id: match.id,
        type,
        title: `${type.toUpperCase()} VS ${opponent}`,
        subtitle: match.round?.tournament?.name || 'Unknown Tournament',
        time: match.createdAt.toISOString().split('T')[0],
        value: `${myScore} - ${oppScore}`,
        player1: {
          id: match.player1Id,
          name: match.player1?.username || match.p1Name || 'TBD',
          avatarUrl: match.player1?.avatarUrl || null,
          score: match.player1Score,
        },
        player2: {
          id: match.player2Id,
          name: match.player2?.username || match.p2Name || 'TBD',
          avatarUrl: match.player2?.avatarUrl || null,
          score: match.player2Score,
        },
        isPlayer1,
      };
    });
  }
}
