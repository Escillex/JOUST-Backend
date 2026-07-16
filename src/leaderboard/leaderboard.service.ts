import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  effectiveRawConfig,
  resolveConfig,
} from '../Formats/format-config.helper';

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
  avatarUrl?: string | null;
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
      omw: (e) => e.omw,
      oomw: (e) => e.oomw,
      matchWinPct: (e) => e.matchWinPct,
      wins: (e) => e.wins,
      losses: (e) => -e.losses, // fewer losses = better
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
      omw: (e) => e.omw,
      oomw: (e) => e.oomw,
      matchWinPct: (e) => e.matchWinPct,
      wins: (e) => e.wins,
      losses: (e) => e.losses,
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
    const participants = await this.prisma.tournamentParticipant.findMany({
      where: { tournamentId },
      include: {
        stats: true,
        user: { select: { id: true, username: true, avatarUrl: true } },
        tournament: { include: { format: true } },
      },
    });

    const tournament =
      participants[0]?.tournament ??
      (await this.prisma.tournament.findUnique({
        where: { id: tournamentId },
        include: { format: true },
      }));

    const rawConfig = effectiveRawConfig(tournament);
    const config = resolveConfig(rawConfig);
    const { tieBreakerOrder } = config;

    const entries: Omit<LeaderboardEntry, 'rank'>[] = participants.map((p) => ({
      userId: p.userId,
      username: p.user?.username ?? 'Guest',
      points: p.stats?.points ?? 0,
      wins: p.stats?.wins ?? 0,
      losses: p.stats?.losses ?? 0,
      draws: p.stats?.draws ?? 0,
      matchWinPct: p.stats?.winRate ?? 0,
      omw: p.stats?.omw ?? 0,
      oomw: p.stats?.oomw ?? 0,
      avatarUrl: p.user?.avatarUrl ?? null,
    }));

    const sorted = this.sortEntries(entries, tieBreakerOrder);

    const ranked: LeaderboardEntry[] = [];
    let currentRank = 1;
    for (let i = 0; i < sorted.length; i++) {
      if (
        i > 0 &&
        this.rankChanged(sorted[i - 1], sorted[i], tieBreakerOrder)
      ) {
        currentRank = i + 1;
      }
      ranked.push({ rank: currentRank, ...sorted[i] });
    }

    return ranked;
  }

  // ─── GLOBAL LEADERBOARD ──────────────────────────────────────

  async getGlobalLeaderboard(
    gameName?: string,
  ): Promise<GlobalLeaderboardEntry[]> {
    // Per-game boards read UserGameStats; the all-games board reads
    // UserGlobalStats. Both models share the aggregated field names.
    const globalStats = gameName
      ? await this.prisma.userGameStats.findMany({
          where: {
            gameName,
            user: { isGuest: false },
          },
          include: {
            user: { select: { id: true, username: true, avatarUrl: true } },
          },
        })
      : await this.prisma.userGlobalStats.findMany({
          where: {
            user: { isGuest: false },
          },
          include: {
            user: { select: { id: true, username: true, avatarUrl: true } },
          },
        });

    const entries: Omit<GlobalLeaderboardEntry, 'rank'>[] = globalStats.map(
      (stat) => ({
        userId: stat.userId,
        username: stat.user?.username ?? 'Unknown',
        points: stat.globalPoints,
        wins: stat.wins,
        losses: stat.losses,
        draws: stat.draws,
        matchWinPct: stat.winRate,
        omw: stat.winRate,
        oomw: stat.winRate,
        tournamentsPlayed: stat.tournamentsPlayed,
        avatarUrl: stat.user?.avatarUrl ?? null,
      }),
    );

    const globalTieBreakerOrder: string[] = [];
    const sorted = this.sortEntries(entries, globalTieBreakerOrder);

    const ranked: GlobalLeaderboardEntry[] = [];
    let currentRank = 1;
    for (let i = 0; i < sorted.length; i++) {
      if (
        i > 0 &&
        this.rankChanged(sorted[i - 1], sorted[i], globalTieBreakerOrder)
      ) {
        currentRank = i + 1;
      }
      ranked.push({ rank: currentRank, ...sorted[i] });
    }

    return ranked;
  }

  // ─── GAMES ────────────────────────────────────────────────────

  /** Distinct game designations across format presets, for board filtering. */
  async getGames(): Promise<string[]> {
    const formats = await this.prisma.tournamentFormat.findMany({
      where: { gameName: { not: null } },
      select: { gameName: true },
      distinct: ['gameName'],
      orderBy: { gameName: 'asc' },
    });
    return formats.map((f) => f.gameName as string);
  }

  // ─── USER STATS ───────────────────────────────────────────────

  async getUserStats(userId: string): Promise<GlobalLeaderboardEntry | null> {
    const globalLeaderboard = await this.getGlobalLeaderboard();
    return globalLeaderboard.find((entry) => entry.userId === userId) || null;
  }
}
