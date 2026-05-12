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
import { resolveConfig, winsNeeded } from '../../Formats/format-config.helper';

@Injectable()
export class MatchService {
  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => FormatsService))
    private formatsService: FormatsService,
  ) {}

  // ─── CREATE / LINK ────────────────────────────────────────────

  async createMatch(dto: {
    roundId: string;
    player1Id?: string;
    player2Id?: string;
    isBye: boolean;
    phase?: number;
  }) {
    return this.prisma.match.create({
      data: {
        roundId:   dto.roundId,
        player1Id: dto.player1Id ?? null,
        player2Id: dto.player2Id ?? null,
        isBye:     dto.isBye,
        phase:     dto.phase ?? 1,
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

  // ─── SUBMIT RESULT (direct / override) ───────────────────────

  /**
   * Direct result submission. Works for single-game matches or admin overrides.
   * For bestOf > 1 tournaments, use reportGameResult() instead to track
   * per-game scores; passing a winnerId here will still force-complete the match.
   */
  async submitResult(matchId: string, winnerId?: string) {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: {
        round: {
          include: {
            tournament: {
              include: { format: true },
            },
          },
        },
      },
    });

    if (!match) throw new NotFoundException('Match not found');
    if (match.status === MatchStatus.COMPLETED)
      throw new BadRequestException('Match already completed');

    if (winnerId) {
      const validPlayers = [match.player1Id, match.player2Id].filter(Boolean);
      if (!validPlayers.includes(winnerId))
        throw new BadRequestException('Winner must be in match');
    }

    const rawConfig = (match.round.tournament.format?.config as Record<string, any>) ?? {};
    const config = resolveConfig(rawConfig);
    const {
      sessionsCount,
      pointsThreshold,
      bestOf,
      allowDraw,
      tieBreakerOrder,
      progressionType,
    } = config;

    if (bestOf <= 0)
      throw new BadRequestException('bestOf must be a positive integer');

    if (sessionsCount <= 0)
      throw new BadRequestException('sessionsCount must be a positive integer');

    if (!winnerId && !allowDraw)
      throw new BadRequestException(
        'Match must have a winner unless draws are explicitly allowed',
      );

    if (pointsThreshold > 0 && !winnerId)
      throw new BadRequestException(
        `This match requires a points threshold of ${pointsThreshold} to determine a winner`,
      );

    // Guard: warn when submitting a direct result on a bestOf > 1 match
    // without a winnerId — scores would be lost. A winnerId forces completion.
    if (bestOf > 1 && !winnerId) {
      throw new BadRequestException(
        `This match is Best of ${bestOf}. Use POST /match/${matchId}/game-result ` +
        `to report game-by-game, or provide a winnerId to force-complete.`,
      );
    }

    const completed = await this.prisma.match.update({
      where: { id: matchId },
      data: { winnerId: winnerId || null, status: MatchStatus.COMPLETED },
    });

    await this.formatsService.handleMatchCompletion(matchId);

    return {
      message: 'Result submitted',
      match: completed,
      formatApplied: {
        sessionsCount,
        pointsThreshold,
        bestOf,
        allowDraw,
        tieBreakerOrder,
        progressionType,
      },
    };
  }

  // ─── REPORT GAME RESULT (bestOf tracking) ────────────────────

  /**
   * Reports the winner of a single game/set within a bestOf match.
   * Increments that player's score and auto-completes the match once
   * one player reaches Math.ceil(bestOf / 2) wins.
   *
   * Example — Best of 3:
   *   winsNeeded = 2
   *   Game 1 → p1 wins → score 1-0  (match ongoing)
   *   Game 2 → p1 wins → score 2-0  (match complete, p1 wins)
   */
  async reportGameResult(matchId: string, gameWinnerId: string) {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: {
        round: {
          include: {
            tournament: {
              include: {
                format: true,
              },
            },
          },
        },
      },
    });

    if (!match) throw new NotFoundException('Match not found');
    if (match.status === MatchStatus.COMPLETED)
      throw new BadRequestException('Match already completed');
    if (match.isBye)
      throw new BadRequestException('Cannot report game results for a bye match');

    const isP1 = gameWinnerId === match.player1Id;
    const isP2 = gameWinnerId === match.player2Id;
    if (!isP1 && !isP2)
      throw new BadRequestException(
        'Game winner is not a participant in this match',
      );

    const rawConfig = (match.round.tournament.format?.config as Record<string, any>) ?? {};
    const config = resolveConfig(rawConfig);
    const { bestOf } = config;
    const winsReq = winsNeeded(bestOf);

    // Increment the winning player's game score
    const updated = await this.prisma.match.update({
      where: { id: matchId },
      data: {
        player1Score: isP1 ? { increment: 1 } : undefined,
        player2Score: isP2 ? { increment: 1 } : undefined,
      },
    });

    const p1Wins = updated.player1Score;
    const p2Wins = updated.player2Score;

    // Check if the match is now decided
    if (p1Wins >= winsReq || p2Wins >= winsReq) {
      const matchWinnerId =
        p1Wins >= winsReq ? match.player1Id! : match.player2Id!;

      await this.prisma.match.update({
        where: { id: matchId },
        data: { winnerId: matchWinnerId, status: MatchStatus.COMPLETED },
      });

      await this.formatsService.handleMatchCompletion(matchId);

      return {
        matchComplete: true,
        winnerId:      matchWinnerId,
        score:         { player1: p1Wins, player2: p2Wins },
        bestOf,
        winsNeeded:    winsReq,
      };
    }

    // Match still ongoing — return current state
    return {
      matchComplete: false,
      score:         { player1: p1Wins, player2: p2Wins },
      bestOf,
      winsNeeded:    winsReq,
      remaining:     winsReq - Math.max(p1Wins, p2Wins),
    };
  }

  // ─── REPORT DRAW ─────────────────────────────────────────────

  /**
   * Completes a match as a draw (no winnerId).
   * Only permitted when allowDraw is true in the tournament's format.
   */
  async reportDraw(matchId: string) {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: {
        round: {
          include: {
            tournament: {
              include: {
                format: true,
              },
            },
          },
        },
      },
    });

    if (!match) throw new NotFoundException('Match not found');
    if (match.status === MatchStatus.COMPLETED)
      throw new BadRequestException('Match already completed');
    if (match.isBye)
      throw new BadRequestException('Cannot draw a bye match');

    const rawConfig = (match.round.tournament.format?.config as Record<string, any>) ?? {};
    const config = resolveConfig(rawConfig);
    if (!config.allowDraw)
      throw new BadRequestException(
        'Draws are not allowed in this tournament',
      );

    await this.prisma.match.update({
      where: { id: matchId },
      data: { winnerId: null, status: MatchStatus.COMPLETED },
    });

    await this.formatsService.handleMatchCompletion(matchId);

    return {
      matchComplete: true,
      draw:          true,
      score: {
        player1: match.player1Score,
        player2: match.player2Score,
      },
    };
  }

  // ─── ADVANCEMENT ─────────────────────────────────────────────

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
    } else if (updated.isBye && (updated.player1Id || updated.player2Id)) {
      await this.submitResult(nextMatchId, winnerId);
    }
  }

  async advanceLoser(loserId: string, nextMatchId: string) {
    const nextMatch = await this.prisma.match.findUnique({
      where: { id: nextMatchId },
    });
    if (!nextMatch) return;

    const slot = nextMatch.player1Id === null ? 'player1Id' : 'player2Id';
    const updated = await this.prisma.match.update({
      where: { id: nextMatchId },
      data: { [slot]: loserId },
    });

    if (updated.player1Id && updated.player2Id) {
      await this.activateMatch(nextMatchId);
    } else if (updated.isBye && (updated.player1Id || updated.player2Id)) {
      await this.submitResult(nextMatchId, loserId);
    }
  }

  async activateMatch(matchId: string) {
    return this.prisma.match.update({
      where: { id: matchId },
      data: { status: MatchStatus.ONGOING },
    });
  }

  // ─── QUERIES ─────────────────────────────────────────────────

  async getMatch(matchId: string) {
    return this.prisma.match.findUnique({
      where: { id: matchId },
      include: {
        player1: { select: { id: true, username: true, isGuest: true } },
        player2: { select: { id: true, username: true, isGuest: true } },
        winner:  { select: { id: true, username: true, isGuest: true } },
      },
    });
  }

  async getMatchesByRound(roundId: string) {
    return this.prisma.match.findMany({
      where: { roundId },
      include: {
        player1: { select: { id: true, username: true, isGuest: true } },
        player2: { select: { id: true, username: true, isGuest: true } },
        winner:  { select: { id: true, username: true, isGuest: true } },
      },
    });
  }
}