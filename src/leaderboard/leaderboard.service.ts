import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  effectiveRawConfig,
  resolveConfig,
} from '../Formats/format-config.helper';
import { MatchStatus } from '@prisma/client';

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

/** A row in the cross-tournament leaderboard.
 *
 *  Plan 7.2. `omw`/`oomw` are deliberately omitted. They used to be present and
 *  filled with the player's own `winRate` — two fields under opponent-strength
 *  names carrying a number that is not opponent strength at all. Real OMW/OOMW
 *  require an opponent graph, which only exists within a single tournament; the
 *  global board has no such graph, so the honest thing is to not claim it. */
export type GlobalLeaderboardEntry = Omit<LeaderboardEntry, 'omw' | 'oomw'> & {
  tournamentsPlayed: number;
  avatarUrl?: string | null;
  slug?: string | null;
};

/** Sortable entry: opponent tiebreakers are optional because the global board
 *  has no opponent graph to compute them from (7.2). */
type SortableEntry = Omit<LeaderboardEntry, 'rank' | 'omw' | 'oomw'> &
  Partial<Pick<LeaderboardEntry, 'omw' | 'oomw'>>;

@Injectable()
export class LeaderboardService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── PRIVATE HELPERS ─────────────────────────────────────────

  /**
   * Sorts leaderboard entries by points first, then by each tiebreaker
   * in the order specified by tieBreakerOrder. Falls back to
   * ['omw', 'oomw', 'matchWinPct'] if no order is configured.
   */
  private sortEntries<T extends SortableEntry>(
    entries: T[],
    tieBreakerOrder: string[],
  ): T[] {
    const tbGetters: Record<string, (e: T) => number> = {
      omw: (e) => e.omw ?? 0,
      oomw: (e) => e.oomw ?? 0,
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
  private rankChanged<T extends SortableEntry>(
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
      omw: (e) => e.omw ?? 0,
      oomw: (e) => e.oomw ?? 0,
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

  /** The minimum match-win percentage an opponent can contribute. Standard Swiss
   *  practice: without a floor, having faced someone who lost every match drags
   *  your tiebreak down for a result you had no control over. */
  private static readonly MIN_OPPONENT_WIN_PCT = 1 / 3;

  /**
   * Opponent match-win percentage (OMW) and opponent's-opponent (OOMW) for every
   * player in a tournament, derived from completed matches.
   *
   * OMW is the average win rate of everyone you played — it rewards a hard road
   * over an easy one when two players finish on equal points. OOMW applies the
   * same idea one level further out. Byes are excluded from opponent lists, since
   * there is no opponent to measure.
   */
  private async computeOpponentTiebreakers(
    tournamentId: string,
  ): Promise<Map<string, { omw: number; oomw: number }>> {
    const matches = await this.prisma.match.findMany({
      where: {
        round: { tournamentId },
        status: MatchStatus.COMPLETED,
        isBye: false,
      },
      select: { player1Id: true, player2Id: true, winnerId: true },
    });

    const opponents = new Map<string, string[]>();
    const played = new Map<string, number>();
    const won = new Map<string, number>();

    const bump = (map: Map<string, number>, key: string) =>
      map.set(key, (map.get(key) ?? 0) + 1);

    for (const m of matches) {
      if (!m.player1Id || !m.player2Id) continue;

      opponents.set(m.player1Id, [
        ...(opponents.get(m.player1Id) ?? []),
        m.player2Id,
      ]);
      opponents.set(m.player2Id, [
        ...(opponents.get(m.player2Id) ?? []),
        m.player1Id,
      ]);

      bump(played, m.player1Id);
      bump(played, m.player2Id);
      if (m.winnerId) bump(won, m.winnerId);
    }

    // Pass 1: each player's own win rate, floored.
    const winPct = new Map<string, number>();
    for (const [userId, count] of played) {
      const raw = count > 0 ? (won.get(userId) ?? 0) / count : 0;
      winPct.set(
        userId,
        Math.max(raw, LeaderboardService.MIN_OPPONENT_WIN_PCT),
      );
    }

    // Pass 2: OMW is the mean of your opponents' win rates.
    const omw = new Map<string, number>();
    for (const [userId, list] of opponents) {
      const total = list.reduce((sum, id) => sum + (winPct.get(id) ?? 0), 0);
      omw.set(userId, list.length > 0 ? total / list.length : 0);
    }

    // Pass 3: OOMW is the mean of your opponents' OMW, so it needs pass 2 first.
    const result = new Map<string, { omw: number; oomw: number }>();
    for (const [userId, list] of opponents) {
      const total = list.reduce((sum, id) => sum + (omw.get(id) ?? 0), 0);
      result.set(userId, {
        omw: omw.get(userId) ?? 0,
        oomw: list.length > 0 ? total / list.length : 0,
      });
    }

    return result;
  }

  /**
   * Which tiebreaker actually separated two entries, or null when none did.
   * Used so the organizer is told what decided a tie instead of being given a
   * fixed message that may not be true.
   */
  tiebreakCriterion(
    a: Omit<LeaderboardEntry, 'rank'>,
    b: Omit<LeaderboardEntry, 'rank'>,
    tieBreakerOrder: string[],
  ): string | null {
    if (a.points !== b.points) return 'points';

    const order =
      tieBreakerOrder.length > 0
        ? tieBreakerOrder
        : ['omw', 'oomw', 'matchWinPct'];

    const getters: Record<
      string,
      (e: Omit<LeaderboardEntry, 'rank'>) => number
    > = {
      omw: (e) => e.omw,
      oomw: (e) => e.oomw,
      matchWinPct: (e) => e.matchWinPct,
      wins: (e) => e.wins,
      losses: (e) => e.losses,
    };

    for (const tb of order) {
      const getter = getters[tb];
      if (!getter) continue;
      if (Math.abs(getter(a) - getter(b)) > 0.0001) return tb;
    }

    return null;
  }

  // ─── STRUCTURAL PLACEMENT (plan 8.2) ─────────────────────────────

  /**
   * Final placings for a bracket, derived from the bracket itself rather than
   * from accumulated match points.
   *
   * Why this has to exist before match points can be removed (plan 8a): the
   * placement award and the "You placed #N" notification both read
   * `getLeaderboard().rank`, which ranks on points. Drop the points without a
   * replacement and every elimination entrant sits on 0, ranking falls through
   * to the default tiebreakers — and **omw sorts first**. Opponent win
   * percentage says nothing about how far a player got; a round-1 casualty who
   * happened to lose to the eventual champion scores very highly on it. That
   * would feed the global leaderboard near-noise.
   *
   * It also fixes 8b outright. In a hybrid, a 5-0 Swiss player who loses the
   * final can finish on more points than the player who won it, so the points
   * ranking paid the runner-up the champion's global points while the tournament
   * recorded the actual winner. Placement is now decided by who won, not by who
   * accumulated.
   *
   * Method: a player's finish is fixed by the round of their LAST loss.
   * - Single elimination — one loss ends you, so that is your exit round.
   * - Double elimination — the first loss only drops you to the losers bracket;
   *   the second ends you. Taking the last loss handles both. The round
   *   numbering already orders this correctly (winners 1..k, losers 101+,
   *   grand final 200), so a later number is always a deeper run.
   * - Whoever never lost, or won the decider, is champion.
   *
   * Players eliminated in the same round share a rank — both losing
   * semifinalists are 3rd — and the next group starts at rank + groupSize,
   * which is standard competition ranking.
   *
   * @param phase restricts to one phase of a hybrid event (2 = the top cut).
   */
  async computeStructuralPlacements(
    tournamentId: string,
    phase?: number,
  ): Promise<Map<string, number>> {
    const matches = await this.prisma.match.findMany({
      where: {
        round: { tournamentId },
        status: MatchStatus.COMPLETED,
        isBye: false,
        ...(phase !== undefined ? { phase } : {}),
      },
      select: {
        player1Id: true,
        player2Id: true,
        winnerId: true,
        nextMatchId: true,
        round: { select: { roundNumber: true } },
      },
    });

    if (matches.length === 0) return new Map();

    const lastLossRound = new Map<string, number>();
    const everyone = new Set<string>();

    for (const m of matches) {
      const roundNumber = m.round.roundNumber;
      for (const id of [m.player1Id, m.player2Id]) {
        if (id) everyone.add(id);
      }
      if (!m.winnerId) continue; // a draw eliminates nobody
      const loserId = m.player1Id === m.winnerId ? m.player2Id : m.player1Id;
      if (!loserId) continue;
      lastLossRound.set(
        loserId,
        Math.max(lastLossRound.get(loserId) ?? -Infinity, roundNumber),
      );
    }

    // The decider is the completed match nothing advances out of, in the
    // highest round — the final in single elimination, round 200 in double.
    const decider = matches
      .filter((m) => m.nextMatchId === null && m.winnerId)
      .sort((a, b) => b.round.roundNumber - a.round.roundNumber)[0];

    const champion = decider?.winnerId ?? null;

    // Deeper run first; the champion (no elimination) sorts ahead of everyone.
    const ranked = [...everyone].sort((a, b) => {
      const aOut =
        a === champion ? Infinity : (lastLossRound.get(a) ?? -Infinity);
      const bOut =
        b === champion ? Infinity : (lastLossRound.get(b) ?? -Infinity);
      return bOut - aOut;
    });

    const placements = new Map<string, number>();
    let rank = 0;
    let seen = 0;
    let previousOut: number | null = null;
    for (const userId of ranked) {
      const out =
        userId === champion
          ? Infinity
          : (lastLossRound.get(userId) ?? -Infinity);
      seen += 1;
      if (previousOut === null || out !== previousOut) {
        rank = seen; // standard competition ranking: 1,2,3,3,5...
        previousOut = out;
      }
      placements.set(userId, rank);
    }

    return placements;
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

    // OMW/OOMW are derived from the match graph at read time rather than stored.
    // The TournamentParticipantStats.omw/oomw columns were never written by
    // anything, so both tiebreakers silently compared 0 to 0 and fell through.
    const opponentStats = await this.computeOpponentTiebreakers(tournamentId);

    const entries: Omit<LeaderboardEntry, 'rank'>[] = participants.map((p) => ({
      userId: p.userId,
      username: p.user?.username ?? 'Guest',
      points: p.stats?.points ?? 0,
      wins: p.stats?.wins ?? 0,
      losses: p.stats?.losses ?? 0,
      draws: p.stats?.draws ?? 0,
      matchWinPct: p.stats?.winRate ?? 0,
      omw: opponentStats.get(p.userId)?.omw ?? 0,
      oomw: opponentStats.get(p.userId)?.oomw ?? 0,
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
            user: {
              select: { id: true, username: true, slug: true, avatarUrl: true },
            },
          },
        })
      : await this.prisma.userGlobalStats.findMany({
          where: {
            user: { isGuest: false },
          },
          include: {
            user: {
              select: { id: true, username: true, slug: true, avatarUrl: true },
            },
          },
        });

    const entries: Omit<GlobalLeaderboardEntry, 'rank'>[] = globalStats.map(
      (stat) => ({
        userId: stat.userId,
        username: stat.user?.username ?? 'Unknown',
        slug: stat.user?.slug ?? null,
        points: stat.globalPoints,
        wins: stat.wins,
        losses: stat.losses,
        draws: stat.draws,
        matchWinPct: stat.winRate,
        tournamentsPlayed: stat.tournamentsPlayed,
        avatarUrl: stat.user?.avatarUrl ?? null,
      }),
    );

    // Explicit, because an empty array does NOT mean "no tiebreakers" — the
    // sorter falls back to ['omw','oomw','matchWinPct'], and with omw/oomw
    // removed (7.2) that fallback would read undefined. Win rate is the only
    // discriminator this board actually has.
    const globalTieBreakerOrder: string[] = ['matchWinPct'];
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
