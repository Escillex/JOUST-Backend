import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MatchStatus } from '@prisma/client';
import { resolveConfig } from '../Formats/format-config.helper';

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  points: number;
  wins: number;
  losses: number;
  draws: number;
  matchWinPct: number;
  omw: number;
  oomw: number;
}

export interface GlobalLeaderboardEntry extends LeaderboardEntry {
  tournamentsPlayed: number;
}

@Injectable()
export class LeaderboardService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── PRIVATE HELPERS ─────────────────────────────────────────

  /**
   * Sorts leaderboard entries by points first, then by each tiebreaker
   * in the order specified by tieBreakerOrder. Falls back to
   * ['omw', 'oomw', 'matchWinPct'] if no order is configured.
   */
  private sortEntries<T extends Omit<LeaderboardEntry, 'rank'>>(
    entries: T[],
    tieBreakerOrder: string[],
  ): T[] {
    const tbGetters: Record<string, (e: T) => number> = {
      omw:         (e) => e.omw,
      oomw:        (e) => e.oomw,
      matchWinPct: (e) => e.matchWinPct,
      wins:        (e) => e.wins,
      losses:      (e) => -(e.losses), // fewer losses = better
    };

    const order =
      tieBreakerOrder.length > 0
        ? tieBreakerOrder
        : ['omw', 'oomw', 'matchWinPct'];

    return [...entries].sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;

      for (const tb of order) {
        const getter = tbGetters[tb];
        if (!getter) continue;
        const diff = getter(b) - getter(a);
        if (Math.abs(diff) > 0.0001) return diff;
      }

      return 0;
    });
  }

  /**
   * Returns true when two adjacent sorted entries should have different ranks
   * (i.e. they differ on points or on any active tiebreaker).
   */
  private rankChanged<T extends Omit<LeaderboardEntry, 'rank'>>(
    prev: T,
    curr: T,
    tieBreakerOrder: string[],
  ): boolean {
    if (prev.points !== curr.points) return true;

    const order =
      tieBreakerOrder.length > 0
        ? tieBreakerOrder
        : ['omw', 'oomw', 'matchWinPct'];

    const getters: Record<string, (e: T) => number> = {
      omw:         (e) => e.omw,
      oomw:        (e) => e.oomw,
      matchWinPct: (e) => e.matchWinPct,
      wins:        (e) => e.wins,
      losses:      (e) => e.losses,
    };

    for (const tb of order) {
      const getter = getters[tb];
      if (!getter) continue;
      if (Math.abs(getter(prev) - getter(curr)) > 0.0001) return true;
    }

    return false;
  }

  // ─── TOURNAMENT LEADERBOARD ──────────────────────────────────

  async getLeaderboard(tournamentId: string): Promise<LeaderboardEntry[]> {
    const matches = await this.prisma.match.findMany({
      where: {
        round: { tournamentId },
        status: MatchStatus.COMPLETED,
      },
      select: {
        player1Id: true,
        player2Id: true,
        winnerId: true,
        isBye: true,
      },
    });

    const participants = await this.prisma.tournamentParticipant.findMany({
      where: { tournamentId },
      include: { user: { select: { id: true, username: true } } },
    });

    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: { format: true },
    });

    const rawConfig = (tournament?.format?.config as Record<string, any>) ?? {};
    const config = resolveConfig(rawConfig);
    const {
      swissPointsForWin: pointsForWin,
      swissPointsForDraw: pointsForDraw,
      swissPointsForLoss: pointsForLoss,
      tieBreakerOrder,
    } = config;

    const playerIds = participants.map((p) => p.userId);

    const opponentMap   = new Map<string, Set<string>>();
    const winsMap       = new Map<string, number>();
    const lossesMap     = new Map<string, number>();
    const drawsMap      = new Map<string, number>();
    const matchCountMap = new Map<string, number>();

    for (const id of playerIds) {
      opponentMap.set(id, new Set());
      winsMap.set(id, 0);
      lossesMap.set(id, 0);
      drawsMap.set(id, 0);
      matchCountMap.set(id, 0);
    }

    for (const match of matches) {
      const { player1Id: p1, player2Id: p2, winnerId, isBye } = match;
      if (!p1) continue;

      if (isBye) {
        winsMap.set(p1, (winsMap.get(p1) ?? 0) + 1);
        continue;
      }

      if (!p2) continue;

      matchCountMap.set(p1, (matchCountMap.get(p1) ?? 0) + 1);
      matchCountMap.set(p2, (matchCountMap.get(p2) ?? 0) + 1);
      opponentMap.get(p1)?.add(p2);
      opponentMap.get(p2)?.add(p1);

      if (!winnerId) {
        drawsMap.set(p1, (drawsMap.get(p1) ?? 0) + 1);
        drawsMap.set(p2, (drawsMap.get(p2) ?? 0) + 1);
      } else if (winnerId === p1) {
        winsMap.set(p1, (winsMap.get(p1) ?? 0) + 1);
        lossesMap.set(p2, (lossesMap.get(p2) ?? 0) + 1);
      } else {
        winsMap.set(p2, (winsMap.get(p2) ?? 0) + 1);
        lossesMap.set(p1, (lossesMap.get(p1) ?? 0) + 1);
      }
    }

    // Match win percentage (floored at 0.33)
    const mwpMap = new Map<string, number>();
    for (const id of playerIds) {
      const wins         = winsMap.get(id) ?? 0;
      const draws        = drawsMap.get(id) ?? 0;
      const matchesPlayed = matchCountMap.get(id) ?? 0;
      const byes         = matches.filter((m) => m.isBye && m.player1Id === id).length;
      const realWins     = wins - byes;

      const possiblePoints = matchesPlayed * pointsForWin;
      const earnedPoints   = realWins * pointsForWin + draws * pointsForDraw;
      const raw = possiblePoints === 0 ? 0.33 : earnedPoints / possiblePoints;
      mwpMap.set(id, Math.max(raw, 0.33));
    }

    // Opponent match win percentage
    const omwMap = new Map<string, number>();
    for (const id of playerIds) {
      const opponents = [...(opponentMap.get(id) ?? [])];
      if (opponents.length === 0) { omwMap.set(id, 0.33); continue; }
      const avg =
        opponents.reduce((sum, oppId) => sum + (mwpMap.get(oppId) ?? 0.33), 0) /
        opponents.length;
      omwMap.set(id, Math.max(avg, 0.33));
    }

    // Opponent's opponent match win percentage
    const oomwMap = new Map<string, number>();
    for (const id of playerIds) {
      const opponents = [...(opponentMap.get(id) ?? [])];
      if (opponents.length === 0) { oomwMap.set(id, 0.33); continue; }
      const avg =
        opponents.reduce((sum, oppId) => sum + (omwMap.get(oppId) ?? 0.33), 0) /
        opponents.length;
      oomwMap.set(id, avg);
    }

    const entries: Omit<LeaderboardEntry, 'rank'>[] = participants.map((p) => {
      const id     = p.userId;
      const wins   = winsMap.get(id)   ?? 0;
      const losses = lossesMap.get(id) ?? 0;
      const draws  = drawsMap.get(id)  ?? 0;
      const byes   = matches.filter((m) => m.isBye && m.player1Id === id).length;
      const realWins = wins - byes;

      return {
        userId:      id,
        username:    p.user.username ?? 'Guest',
        points:
          realWins * pointsForWin  +
          draws    * pointsForDraw +
          losses   * pointsForLoss +
          byes     * pointsForWin,
        wins,
        losses,
        draws,
        matchWinPct: mwpMap.get(id)  ?? 0.33,
        omw:         omwMap.get(id)  ?? 0.33,
        oomw:        oomwMap.get(id) ?? 0.33,
      };
    });

    // ← dynamic sort driven by tieBreakerOrder
    const sorted = this.sortEntries(entries, tieBreakerOrder);

    const ranked: LeaderboardEntry[] = [];
    let currentRank = 1;
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0 && this.rankChanged(sorted[i - 1], sorted[i], tieBreakerOrder)) {
        currentRank = i + 1;
      }
      ranked.push({ rank: currentRank, ...sorted[i] });
    }

    return ranked;
  }

  // ─── GLOBAL LEADERBOARD ──────────────────────────────────────

  async getGlobalLeaderboard(): Promise<GlobalLeaderboardEntry[]> {
    const matches = await this.prisma.match.findMany({
      where: { status: MatchStatus.COMPLETED },
      select: {
        player1Id: true,
        player2Id: true,
        winnerId: true,
        isBye: true,
        round: {
          select: {
            tournament: {
              select: {
                id: true,
                format: {
                  select: {
                    config: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    const participants = await this.prisma.tournamentParticipant.findMany({
      where: { user: { isGuest: false } },
      include: { user: { select: { id: true, username: true } } },
    });

    const tournamentSetByUser = new Map<string, Set<string>>();
    const participantMap      = new Map<string, string>();

    for (const p of participants) {
      participantMap.set(p.userId, p.user.username ?? 'Guest');
      const set = tournamentSetByUser.get(p.userId) ?? new Set<string>();
      set.add(p.tournamentId);
      tournamentSetByUser.set(p.userId, set);
    }

    const winsMap       = new Map<string, number>();
    const lossesMap     = new Map<string, number>();
    const drawsMap      = new Map<string, number>();
    const matchCountMap = new Map<string, number>();
    const opponentMap   = new Map<string, Set<string>>();
    const pointsMap     = new Map<string, number>();

    const getTournamentPoints = (tournament: any) => {
      const rawConfig = (tournament?.format?.config as Record<string, any>) ?? {};
      const config = resolveConfig(rawConfig);
      return {
        pointsForWin:  config.swissPointsForWin,
        pointsForDraw: config.swissPointsForDraw,
        pointsForLoss: config.swissPointsForLoss,
      };
    };

    const ensurePlayer = (id: string) => {
      if (!winsMap.has(id)) {
        winsMap.set(id, 0);
        lossesMap.set(id, 0);
        drawsMap.set(id, 0);
        matchCountMap.set(id, 0);
        pointsMap.set(id, 0);
        opponentMap.set(id, new Set());
      }
    };

    for (const match of matches) {
      const { player1Id: p1, player2Id: p2, winnerId, isBye, round } = match;
      const tournament = round?.tournament;
      if (!p1 || !tournament) continue;

      const { pointsForWin, pointsForDraw, pointsForLoss } =
        getTournamentPoints(tournament);

      ensurePlayer(p1);
      if (p2) ensurePlayer(p2);

      if (isBye) {
        pointsMap.set(p1, (pointsMap.get(p1) ?? 0) + pointsForWin);
        winsMap.set(p1, (winsMap.get(p1) ?? 0) + 1);
        continue;
      }

      if (!p2) continue;

      matchCountMap.set(p1, (matchCountMap.get(p1) ?? 0) + 1);
      matchCountMap.set(p2, (matchCountMap.get(p2) ?? 0) + 1);
      opponentMap.get(p1)?.add(p2);
      opponentMap.get(p2)?.add(p1);

      if (!winnerId) {
        drawsMap.set(p1, (drawsMap.get(p1) ?? 0) + 1);
        drawsMap.set(p2, (drawsMap.get(p2) ?? 0) + 1);
        pointsMap.set(p1, (pointsMap.get(p1) ?? 0) + pointsForDraw);
        pointsMap.set(p2, (pointsMap.get(p2) ?? 0) + pointsForDraw);
      } else if (winnerId === p1) {
        winsMap.set(p1, (winsMap.get(p1) ?? 0) + 1);
        lossesMap.set(p2, (lossesMap.get(p2) ?? 0) + 1);
        pointsMap.set(p1, (pointsMap.get(p1) ?? 0) + pointsForWin);
        pointsMap.set(p2, (pointsMap.get(p2) ?? 0) + pointsForLoss);
      } else {
        winsMap.set(p2, (winsMap.get(p2) ?? 0) + 1);
        lossesMap.set(p1, (lossesMap.get(p1) ?? 0) + 1);
        pointsMap.set(p2, (pointsMap.get(p2) ?? 0) + pointsForWin);
        pointsMap.set(p1, (pointsMap.get(p1) ?? 0) + pointsForLoss);
      }
    }

    const playerIds = Array.from(
      new Set([
        ...participants.map((p) => p.userId),
        ...Array.from(pointsMap.keys()),
      ]),
    );

    for (const id of playerIds) ensurePlayer(id);

    // MWP (global always uses standard 3/1/0 for percentage denominator)
    const mwpMap = new Map<string, number>();
    for (const id of playerIds) {
      const wins          = winsMap.get(id)       ?? 0;
      const draws         = drawsMap.get(id)       ?? 0;
      const matchesPlayed = matchCountMap.get(id)  ?? 0;
      const possiblePoints = matchesPlayed * 3;
      const earnedPoints   = wins * 3 + draws * 1;
      const raw = possiblePoints === 0 ? 0.33 : Math.max(earnedPoints / possiblePoints, 0.33);
      mwpMap.set(id, raw);
    }

    const omwMap = new Map<string, number>();
    for (const id of playerIds) {
      const opponents = [...(opponentMap.get(id) ?? [])];
      if (opponents.length === 0) { omwMap.set(id, 0.33); continue; }
      const avg =
        opponents.reduce((sum, oppId) => sum + (mwpMap.get(oppId) ?? 0.33), 0) /
        opponents.length;
      omwMap.set(id, Math.max(avg, 0.33));
    }

    const oomwMap = new Map<string, number>();
    for (const id of playerIds) {
      const opponents = [...(opponentMap.get(id) ?? [])];
      if (opponents.length === 0) { oomwMap.set(id, 0.33); continue; }
      const avg =
        opponents.reduce((sum, oppId) => sum + (omwMap.get(oppId) ?? 0.33), 0) /
        opponents.length;
      oomwMap.set(id, avg);
    }

    const entries: Omit<GlobalLeaderboardEntry, 'rank'>[] = playerIds.map((id) => ({
      userId:            id,
      username:          participantMap.get(id) ?? 'Guest',
      points:            pointsMap.get(id)      ?? 0,
      wins:              winsMap.get(id)        ?? 0,
      losses:            lossesMap.get(id)      ?? 0,
      draws:             drawsMap.get(id)       ?? 0,
      matchWinPct:       mwpMap.get(id)         ?? 0.33,
      omw:               omwMap.get(id)         ?? 0.33,
      oomw:              oomwMap.get(id)         ?? 0.33,
      tournamentsPlayed: tournamentSetByUser.get(id)?.size ?? 0,
    }));

    // Global leaderboard uses default order (no per-tournament config)
    const globalTieBreakerOrder: string[] = [];
    const sorted = this.sortEntries(entries, globalTieBreakerOrder);

    const ranked: GlobalLeaderboardEntry[] = [];
    let currentRank = 1;
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0 && this.rankChanged(sorted[i - 1], sorted[i], globalTieBreakerOrder)) {
        currentRank = i + 1;
      }
      ranked.push({ rank: currentRank, ...sorted[i] });
    }

    return ranked;
  }

  // ─── USER STATS ───────────────────────────────────────────────

  async getUserStats(userId: string): Promise<GlobalLeaderboardEntry | null> {
    const globalLeaderboard = await this.getGlobalLeaderboard();
    return globalLeaderboard.find((entry) => entry.userId === userId) || null;
  }
}