import {
  Injectable,
  BadRequestException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MatchService } from '../tournament/match/match.service';
import {
  LeaderboardService,
  LeaderboardEntry,
} from '../leaderboard/leaderboard.service';
import {
  TournamentFormat,
  MatchStatus,
  TournamentStatus,
  Match,
} from '@prisma/client';

@Injectable()
export class FormatsService {
  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => MatchService))
    private matchService: MatchService,
    private leaderboardService: LeaderboardService,
  ) {}

  async initializeTournamentFormat(
    tournamentId: string,
    format: TournamentFormat,
    playerIds: string[],
  ) {
    if (format === TournamentFormat.SINGLE_ELIMINATION) {
      await this.initSingleElimination(tournamentId, playerIds);
    } else if (format === TournamentFormat.SWISS) {
      await this.initSwiss(tournamentId, playerIds);
    } else {
      throw new BadRequestException(`Format ${format} not supported yet`);
    }
  }

  async handleMatchCompletion(matchId: string) {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: { round: { include: { tournament: true } } },
    });

    if (!match) return;

    const { tournament } = match.round;

    if (tournament.format === TournamentFormat.SINGLE_ELIMINATION) {
      if (match.nextMatchId && match.winnerId) {
        await this.matchService.advanceWinner(
          match.winnerId,
          match.nextMatchId,
        );
      }
      await this.checkSingleEliminationComplete(tournament.id, match.roundId);
    } else if (tournament.format === TournamentFormat.SWISS) {
      await this.checkSwissRoundComplete(tournament.id, match.roundId);
    }
  }

  // ─── SINGLE ELIMINATION ───────────────────────────────────────

  private async initSingleElimination(
    tournamentId: string,
    playerIds: string[],
  ) {
    const bracketSize = this.nextPowerOfTwo(playerIds.length);
    const padded: (string | null)[] = [
      ...playerIds,
      ...Array<string | null>(bracketSize - playerIds.length).fill(null),
    ];
    const rounds = this.generateBracket(padded);

    let prevMatchIds: string[] = [];
    for (let i = 0; i < rounds.length; i++) {
      const round = await this.prisma.round.create({
        data: { tournamentId, roundNumber: i + 1 },
      });

      const currentMatchIds: string[] = [];
      for (const m of rounds[i]) {
        const created = await this.matchService.createMatch({
          roundId: round.id,
          player1Id: m.p1 ?? undefined,
          player2Id: m.p2 ?? undefined,
          isBye: m.p2 === null && i === 0,
        });
        currentMatchIds.push(created.id);

        if (i === 0) {
          if (created.player1Id && created.player2Id) {
            await this.matchService.activateMatch(created.id);
          } else if (created.isBye && created.player1Id) {
            await this.prisma.match.update({
              where: { id: created.id },
              data: {
                winnerId: created.player1Id,
                status: MatchStatus.COMPLETED,
              },
            });
            // We'll handle advancement after linking matches to avoid race conditions
          }
        }
      }

      if (prevMatchIds.length > 0) {
        await this.matchService.linkMatches(prevMatchIds, currentMatchIds);
      }

      // After linking, trigger advancement for byes in round 1
      if (i === 0) {
        const roundMatches = await this.prisma.match.findMany({
          where: { roundId: round.id },
        });
        for (const rm of roundMatches) {
          if (rm.isBye && rm.status === MatchStatus.COMPLETED) {
            await this.handleMatchCompletion(rm.id);
          }
        }
      }

      prevMatchIds = currentMatchIds;
    }
  }

  private async checkSingleEliminationComplete(
    tournamentId: string,
    roundId: string,
  ) {
    const round = await this.prisma.round.findUnique({
      where: { id: roundId },
      include: { matches: true },
    });
    if (!round) return;
    const allDone = round.matches.every(
      (m) => m.status === MatchStatus.COMPLETED,
    );
    if (!allDone) return;

    const nextRound = await this.prisma.round.findFirst({
      where: { tournamentId, roundNumber: round.roundNumber + 1 },
    });

    if (!nextRound) {
      await this.prisma.tournament.update({
        where: { id: tournamentId },
        data: { status: TournamentStatus.COMPLETED },
      });
    }
  }

  // ─── SWISS ───────────────────────────────────────────────────

  private async initSwiss(tournamentId: string, playerIds: string[]) {
    const shuffledPlayers = this.shuffle(playerIds);
    const round = await this.prisma.round.create({
      data: { tournamentId, roundNumber: 1 },
    });

    const matchesCreated: Match[] = [];
    for (let i = 0; i < shuffledPlayers.length; i += 2) {
      const p1 = shuffledPlayers[i];
      const p2 = shuffledPlayers[i + 1] || null;
      const match = await this.matchService.createMatch({
        roundId: round.id,
        player1Id: p1,
        player2Id: p2 || undefined,
        isBye: p2 === null,
      });
      matchesCreated.push(match);

      if (p1 && p2) await this.matchService.activateMatch(match.id);
      else if (p1 && !p2) {
        await this.prisma.match.update({
          where: { id: match.id },
          data: { winnerId: p1, status: MatchStatus.COMPLETED },
        });
      }
    }

    // Check if round 1 is already complete (e.g. if all matches were byes or something, though unlikely)
    for (const m of matchesCreated) {
      const updated = await this.prisma.match.findUnique({
        where: { id: m.id },
      });
      if (updated?.status === MatchStatus.COMPLETED) {
        await this.handleMatchCompletion(updated.id);
      }
    }
  }

  private async checkSwissRoundComplete(tournamentId: string, roundId: string) {
    const round = await this.prisma.round.findUnique({
      where: { id: roundId },
      include: { matches: true },
    });
    if (
      !round ||
      !round.matches.every((m) => m.status === MatchStatus.COMPLETED)
    )
      return;

    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: { participants: true },
    });

    const maxRounds = Math.ceil(Math.log2(tournament!.participants.length));
    if (round.roundNumber >= maxRounds) {
      await this.prisma.tournament.update({
        where: { id: tournamentId },
        data: { status: TournamentStatus.COMPLETED },
      });
      return;
    }

    await this.generateNextSwissRound(tournamentId, round.roundNumber + 1);
  }

  private async generateNextSwissRound(
    tournamentId: string,
    roundNumber: number,
  ) {
    const leaderboard = await this.leaderboardService.getLeaderboard(tournamentId);
    const { opponentHistory, byeCount } =
      await this.buildSwissMatchHistory(tournamentId);

    const sortedIds = leaderboard.map((s) => s.userId);
    const pairableIds = [...sortedIds];
    let byePlayer: string | null = null;

    if (pairableIds.length % 2 !== 0) {
      const eligibleByePlayers = sortedIds.filter(
        (playerId) => (byeCount.get(playerId) ?? 0) === 0,
      );
      byePlayer =
        eligibleByePlayers.length > 0
          ? eligibleByePlayers[eligibleByePlayers.length - 1]
          : sortedIds[sortedIds.length - 1];
      const byeIndex = pairableIds.indexOf(byePlayer);
      if (byeIndex >= 0) pairableIds.splice(byeIndex, 1);
    }

    const round = await this.prisma.round.create({
      data: { tournamentId, roundNumber },
    });

    const pairings = this.buildSwissPairings(
      pairableIds,
      leaderboard,
      opponentHistory,
    );

    const matchesCreated: Match[] = [];

    for (const [p1, p2] of pairings) {
      const match = await this.matchService.createMatch({
        roundId: round.id,
        player1Id: p1,
        player2Id: p2,
        isBye: false,
      });
      matchesCreated.push(match);
      await this.matchService.activateMatch(match.id);
    }

    if (byePlayer) {
      const byeMatch = await this.matchService.createMatch({
        roundId: round.id,
        player1Id: byePlayer,
        player2Id: undefined,
        isBye: true,
      });
      matchesCreated.push(byeMatch);
      await this.prisma.match.update({
        where: { id: byeMatch.id },
        data: { winnerId: byePlayer, status: MatchStatus.COMPLETED },
      });
    }

    for (const m of matchesCreated) {
      const updated = await this.prisma.match.findUnique({
        where: { id: m.id },
      });
      if (updated?.status === MatchStatus.COMPLETED) {
        await this.handleMatchCompletion(updated.id);
      }
    }
  }

  private async buildSwissMatchHistory(tournamentId: string) {
    const matches = await this.prisma.match.findMany({
      where: { round: { tournamentId } },
      select: {
        player1Id: true,
        player2Id: true,
        isBye: true,
      },
    });

    const opponentHistory = new Map<string, Set<string>>();
    const byeCount = new Map<string, number>();

    for (const match of matches) {
      const { player1Id: p1, player2Id: p2, isBye } = match;
      if (!p1) continue;

      if (!opponentHistory.has(p1)) opponentHistory.set(p1, new Set());
      byeCount.set(p1, (byeCount.get(p1) ?? 0) + (isBye ? 1 : 0));

      if (isBye || !p2) continue;

      if (!opponentHistory.has(p2)) opponentHistory.set(p2, new Set());
      opponentHistory.get(p1)?.add(p2);
      opponentHistory.get(p2)?.add(p1);
    }

    return { opponentHistory, byeCount };
  }

  private buildSwissPairings(
    playerIds: string[],
    leaderboard: LeaderboardEntry[],
    opponentHistory: Map<string, Set<string>>,
  ) {
    const sortedIds = [...playerIds]; // Assumed sorted by leaderboard rank/points
    const pairings: Array<[string, string]> = [];
    const used = new Set<string>();

    for (let i = 0; i < sortedIds.length; i++) {
      const p1 = sortedIds[i];
      if (used.has(p1)) continue;

      let p2: string | null = null;
      // 1. Try to find an opponent p1 hasn't played yet, prioritizing closest score (already sorted)
      for (let j = i + 1; j < sortedIds.length; j++) {
        const candidate = sortedIds[j];
        if (used.has(candidate)) continue;

        if (!opponentHistory.get(p1)?.has(candidate)) {
          p2 = candidate;
          break;
        }
      }

      // 2. Fallback: if p1 has played everyone left, pick the first available candidate
      if (!p2) {
        for (let j = i + 1; j < sortedIds.length; j++) {
          const candidate = sortedIds[j];
          if (used.has(candidate)) continue;
          p2 = candidate;
          break;
        }
      }

      if (p2) {
        pairings.push([p1, p2]);
        used.add(p1);
        used.add(p2);
      }
    }

    return pairings;
  }

  private shuffle(array: string[]): string[] {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  private nextPowerOfTwo(n: number): number {
    let power = 1;
    while (power < n) power *= 2;
    return power;
  }

  private generateBracket(
    players: (string | null)[],
  ): { p1: string | null; p2: string | null }[][] {
    const rounds: { p1: string | null; p2: string | null }[][] = [];
    let current = players;
    while (current.length > 1) {
      const matches: { p1: string | null; p2: string | null }[] = [];
      for (let i = 0; i < current.length; i += 2) {
        matches.push({ p1: current[i], p2: current[i + 1] || null });
      }
      rounds.push(matches);
      current = Array<string | null>(Math.ceil(current.length / 2)).fill(null);
    }
    return rounds;
  }
}
