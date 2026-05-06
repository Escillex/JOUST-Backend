import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';

@Injectable()
export class RoundService {
  constructor(private prisma: PrismaService) {}

  async getRounds(tournamentId: string) {
    return this.prisma.round.findMany({
      where: { tournamentId },
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
    });
  }

  async getRound(tournamentId: string, roundNumber: number) {
    const round = await this.prisma.round.findUnique({
      where: {
        tournamentId_roundNumber: { tournamentId, roundNumber },
      },
      include: {
        matches: {
          include: {
            player1: { select: { id: true, username: true } },
            player2: { select: { id: true, username: true } },
            winner: { select: { id: true, username: true } },
          },
        },
      },
    });

    if (!round) {
      throw new NotFoundException(`Round ${roundNumber} not found`);
    }

    return round;
  }
}
