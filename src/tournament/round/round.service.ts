import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';

/**
 * The player shape every match carries, identical to the one
 * `GET /tournaments/:id` serves.
 *
 * It has to be identical. The frontend's `Match` type declares
 * `player1: { id, username, displayName?, isGuest? }` and renders a person
 * through `displayNameOf()`, which reads `displayName` and only falls back to
 * the @handle. This route used to select `{ id, username }` alone, so the live
 * view — the one screen left running on a projector — showed "mira-calder"
 * while the bracket beside it showed "Mira Calder". `completeTournament`
 * already burns the display name into its match snapshots for exactly this
 * reason ("so a finished bracket never shows `mira-calder` in one match and
 * `Mira Calder` in the next"); a live match must not be the exception.
 *
 * `isGuest` travels with it for the same reason: it is what the tiles badge a
 * guest entrant with, and its absence reads as "not a guest".
 *
 * Core Rule 9. Pinned by `test/round-payload.e2e-spec.ts`.
 */
const MATCH_PLAYER_SELECT = {
  select: {
    id: true,
    username: true,
    displayName: true,
    isGuest: true,
  },
} as const;

const MATCH_INCLUDE = {
  matches: {
    include: {
      player1: MATCH_PLAYER_SELECT,
      player2: MATCH_PLAYER_SELECT,
      winner: MATCH_PLAYER_SELECT,
    },
  },
} as const;

@Injectable()
export class RoundService {
  constructor(private prisma: PrismaService) {}

  async getRounds(tournamentId: string) {
    return this.prisma.round.findMany({
      where: { tournamentId },
      orderBy: { roundNumber: 'asc' },
      include: MATCH_INCLUDE,
    });
  }

  async getRound(tournamentId: string, roundNumber: number) {
    const round = await this.prisma.round.findUnique({
      where: {
        tournamentId_roundNumber: { tournamentId, roundNumber },
      },
      include: MATCH_INCLUDE,
    });

    if (!round) {
      throw new NotFoundException(`Round ${roundNumber} not found`);
    }

    return round;
  }
}
