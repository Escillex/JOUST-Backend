import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
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

    // Wins and losses
    const wins = await this.prisma.match.count({
      where: {
        winnerId: userId,
        status: MatchStatus.COMPLETED,
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
}
