import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  effectiveRawConfig,
  resolveConfig,
  systemOf,
} from '../Formats/format-config.helper';
import { MatchStatus, TournamentSystem } from '@prisma/client';

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  /** Human name when set; the UI shows this and keeps `username` as the @handle. */
  displayName?: string | null;
  points: number;
  wins: number;
  losses: number;
  draws: number;
  matchWinPct: number;
  omw: number;
  oomw: number;
  /** Games won / games played, across this tournament. In a best-of series
   *  `Match.player1Score` IS games won, which is what this reads. */
  gw: number;
  /** The mean of this player's opponents' GW%, floored like OMW. */
  ogw: number;
  avatarUrl?: string | null;
}

/** A row in the cross-tournament leaderboard.
 *
 *  Plan 7.2. `omw`/`oomw` are deliberately omitted. They used to be present and
 *  filled with the player's own `winRate` — two fields under opponent-strength
 *  names carrying a number that is not opponent strength at all. Real OMW/OOMW
 *  require an opponent graph, which only exists within a single tournament; the
 *  global board has no such graph, so the honest thing is to not claim it.
 *
 *  `gw`/`ogw` are omitted for the same reason as of 2026-09-16: GW% is counted
 *  from per-match game scores, and `UserGlobalStats` keeps match totals only. */
export type GlobalLeaderboardEntry = Omit<
  LeaderboardEntry,
  'omw' | 'oomw' | 'gw' | 'ogw'
> & {
  tournamentsPlayed: number;
  avatarUrl?: string | null;
  slug?: string | null;
};

/** Sortable entry: opponent tiebreakers are optional because the global board
 *  has no opponent graph to compute them from (7.2). */
type SortableEntry = Omit<
  LeaderboardEntry,
  'rank' | 'omw' | 'oomw' | 'gw' | 'ogw'
> &
  Partial<Pick<LeaderboardEntry, 'omw' | 'oomw' | 'gw' | 'ogw'>>;

@Injectable()
export class LeaderboardService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── PRIVATE HELPERS ─────────────────────────────────────────

  /**
   * Sorts leaderboard entries by points first, then by each tiebreaker
   * in the order specified by tieBreakerOrder. Falls back to
   * ['omw', 'gw', 'oomw'] if no order is configured — the conventional order
   * for best-of-three formats.
   */
  private sortEntries<T extends SortableEntry>(
    entries: T[],
    tieBreakerOrder: string[],
  ): T[] {
    const raw = LeaderboardService.tiebreakGetters<T>();
    const tbGetters: Record<string, (e: T) => number> = Object.fromEntries(
      Object.entries(raw).map(([key, get]) => [
        key,
        LeaderboardService.LOWER_IS_BETTER.has(key) ? (e: T) => -get(e) : get,
      ]),
    );

    const order = LeaderboardService.tiebreakOrder(tieBreakerOrder);

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

    const order = LeaderboardService.tiebreakOrder(tieBreakerOrder);
    const getters = LeaderboardService.tiebreakGetters<T>();

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
   * The tiebreakers, in one place.
   *
   * There used to be three copies of this map — one in `sortEntries`, one in
   * `rankChanged`, one in `tiebreakCriterion` — each with its own default
   * order. Adding GW% to only the first made the table sort by one rule, award
   * ranks by another and report a third; two players separated by GW% were
   * sorted apart and then handed the same rank. Caught by game-win.spec.ts.
   */
  private static readonly DEFAULT_TIEBREAK_ORDER = ['omw', 'gw', 'oomw'];

  /** Same constant, readable to callers that need to name the effective order
   *  (the "OMW, GW, and OOMW are identical" refusal in formats.service). */
  static effectiveTiebreakOrder(): string[] {
    return [...LeaderboardService.DEFAULT_TIEBREAK_ORDER];
  }

  private static tiebreakGetters<T extends SortableEntry>(): Record<
    string,
    (e: T) => number
  > {
    return {
      omw: (e) => e.omw ?? 0,
      oomw: (e) => e.oomw ?? 0,
      gw: (e) => e.gw ?? 0,
      ogw: (e) => e.ogw ?? 0,
      matchWinPct: (e) => e.matchWinPct,
      wins: (e) => e.wins,
      losses: (e) => e.losses,
    };
  }

  /** Tiebreakers where a SMALLER number is better. Only the sorter cares:
   *  the equality checks in `rankChanged` and `tiebreakCriterion` compare
   *  magnitudes, so direction is irrelevant to them. */
  private static readonly LOWER_IS_BETTER = new Set(['losses']);

  private static tiebreakOrder(configured: string[]): string[] {
    return configured.length > 0
      ? configured
      : LeaderboardService.DEFAULT_TIEBREAK_ORDER;
  }

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
  ): Promise<
    Map<string, { omw: number; oomw: number; gw: number; ogw: number }>
  > {
    const [matches, byes] = await Promise.all([
      this.prisma.match.findMany({
        where: {
          round: { tournamentId },
          status: MatchStatus.COMPLETED,
          isBye: false,
        },
        select: {
          player1Id: true,
          player2Id: true,
          winnerId: true,
          // In a best-of series these are GAMES won, which is what GW% counts.
          player1Score: true,
          player2Score: true,
        },
      }),
      // Byes are excluded from OPPONENT strength — there is no opponent to be
      // strong — but they count toward your OWN game record, as Swiss rules
      // require. Without this a player whose win was a bye has zero counted
      // games and a GW% of 0, i.e. the artifact ranks them last for having been
      // given a free win. Seen on trinity: Rafael Costa, 3 points, gw=0.000.
      this.prisma.match.findMany({
        where: {
          round: { tournamentId },
          status: MatchStatus.COMPLETED,
          isBye: true,
        },
        select: { winnerId: true, player1Score: true, player2Score: true },
      }),
    ]);

    const opponents = new Map<string, string[]>();
    const played = new Map<string, number>();
    const won = new Map<string, number>();
    // Game counters, separate from the match counters above.
    const gamesWon = new Map<string, number>();
    const gamesPlayed = new Map<string, number>();

    const bump = (map: Map<string, number>, key: string) =>
      map.set(key, (map.get(key) ?? 0) + 1);
    const add = (map: Map<string, number>, key: string, n: number) =>
      map.set(key, (map.get(key) ?? 0) + n);

    for (const m of matches) {
      if (!m.player1Id || !m.player2Id) continue;

      // A match reported without game detail still scores 1–0, so `total` is
      // never 0 for a completed non-bye match and GW% stays defined.
      const total = m.player1Score + m.player2Score;
      add(gamesWon, m.player1Id, m.player1Score);
      add(gamesWon, m.player2Id, m.player2Score);
      add(gamesPlayed, m.player1Id, total);
      add(gamesPlayed, m.player2Id, total);

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

    // A bye credits the player its recorded score, and nothing to any
    // opponent: it never enters `opponents`, so it cannot inflate anybody's
    // OMW or OGW.
    for (const b of byes) {
      if (!b.winnerId) continue;
      const won = Math.max(b.player1Score, b.player2Score, 1);
      add(gamesWon, b.winnerId, won);
      add(gamesPlayed, b.winnerId, won);
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

    // Pass 1b: each player's own GAME win rate. Floored the same way, because
    // it is used as an opponent-strength input below for exactly the same
    // reason: a player on 0% would otherwise drag their opponents down.
    const gwPct = new Map<string, number>();
    for (const [userId, total] of gamesPlayed) {
      const raw = total > 0 ? (gamesWon.get(userId) ?? 0) / total : 0;
      gwPct.set(userId, Math.max(raw, LeaderboardService.MIN_OPPONENT_WIN_PCT));
    }

    // Pass 2: OMW is the mean of your opponents' win rates.
    const omw = new Map<string, number>();
    for (const [userId, list] of opponents) {
      const total = list.reduce((sum, id) => sum + (winPct.get(id) ?? 0), 0);
      omw.set(userId, list.length > 0 ? total / list.length : 0);
    }

    // Pass 3: OOMW is the mean of your opponents' OMW, so it needs pass 2 first.
    // OGW is the mean of your opponents' GW, which needs pass 1b.
    const result = new Map<
      string,
      { omw: number; oomw: number; gw: number; ogw: number }
    >();
    // Every player who appears ANYWHERE, not just those with opponents: a
    // player whose only completed match was a bye is absent from `opponents`
    // entirely, and iterating that map alone left them with no entry, so their
    // credited bye games fell back to a GW% of 0.
    const everyone = new Set<string>([
      ...opponents.keys(),
      ...gamesPlayed.keys(),
    ]);
    for (const userId of everyone) {
      const list = opponents.get(userId) ?? [];
      const total = list.reduce((sum, id) => sum + (omw.get(id) ?? 0), 0);
      const totalGw = list.reduce((sum, id) => sum + (gwPct.get(id) ?? 0), 0);
      result.set(userId, {
        omw: omw.get(userId) ?? 0,
        oomw: list.length > 0 ? total / list.length : 0,
        // The player's OWN game win rate is reported unfloored — the floor
        // exists to stop a weak opponent dragging someone else down, and has
        // no business rewriting your own record.
        gw:
          (gamesPlayed.get(userId) ?? 0) > 0
            ? (gamesWon.get(userId) ?? 0) / (gamesPlayed.get(userId) as number)
            : 0,
        ogw: list.length > 0 ? totalGw / list.length : 0,
      });
    }

    return result;
  }

  /**
   * A player's match record (games, W/L/D, tournament points) derived from the
   * completed-match graph instead of the denormalized `TournamentParticipantStats`
   * rows.
   *
   * Why: those rows are bumped on every result and rolled back on every reset,
   * and nothing ever reconciles them with the matches they describe — a
   * reject → re-report or reset → re-score cycle can leave a record no completed
   * match supports (seen live: a changed round-1 result landed three times in
   * W/L while points stayed flat, so the standings mixed a true OMW with a
   * fabricated record). OMW/OOMW/GW/OGW already derive from the match graph on
   * read; the match record does now too, so every number on the standings agrees
   * with the bracket. Crediting follows the exact branches of
   * `MatchService.updateMatchStats` (win/draw/bye, per-phase config, and the
   * points-zeroed systems).
   */
  private async computeTournamentRecords(
    tournament: {
      config?: unknown;
      system?: TournamentSystem | null;
      format?: { system?: TournamentSystem | null; config?: unknown } | null;
    } | null,
    tournamentId: string,
  ): Promise<
    Map<
      string,
      {
        gamesPlayed: number;
        wins: number;
        losses: number;
        draws: number;
        points: number;
      }
    >
  > {
    const matches = await this.prisma.match.findMany({
      where: { round: { tournamentId }, status: MatchStatus.COMPLETED },
      select: {
        player1Id: true,
        player2Id: true,
        winnerId: true,
        isBye: true,
        phase: true,
      },
    });

    const rawConfig = effectiveRawConfig(tournament);
    const configByPhase = new Map<number, ReturnType<typeof resolveConfig>>();
    const system = systemOf(tournament);
    const record = new Map<
      string,
      {
        gamesPlayed: number;
        wins: number;
        losses: number;
        draws: number;
        points: number;
      }
    >();

    const add = (
      userId: string,
      partial: Partial<{
        gamesPlayed: number;
        wins: number;
        losses: number;
        draws: number;
        points: number;
      }>,
    ) => {
      const cur = record.get(userId) ?? {
        gamesPlayed: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        points: 0,
      };
      record.set(userId, {
        gamesPlayed: cur.gamesPlayed + (partial.gamesPlayed ?? 0),
        wins: cur.wins + (partial.wins ?? 0),
        losses: cur.losses + (partial.losses ?? 0),
        draws: cur.draws + (partial.draws ?? 0),
        points: cur.points + (partial.points ?? 0),
      });
    };

    const credit = (
      userId: string,
      type: 'WIN' | 'LOSS' | 'DRAW',
      pointsFor: number,
    ) => {
      if (type === 'WIN') {
        add(userId, { gamesPlayed: 1, wins: 1, points: pointsFor });
      } else if (type === 'LOSS') {
        add(userId, { gamesPlayed: 1, losses: 1, points: pointsFor });
      } else {
        add(userId, { gamesPlayed: 1, draws: 1, points: pointsFor });
      }
    };

    for (const m of matches) {
      let config = configByPhase.get(m.phase);
      if (!config) {
        config = resolveConfig(rawConfig, m.phase);
        configByPhase.set(m.phase, config);
      }

      // Plan 8.1: match points only apply where standings ARE the result. On a
      // bracket the result is who won, so points are zeroed even though the
      // W/L/D counters still count (they feed match-win percentage everywhere).
      const pointsApply = !(
        system === 'SINGLE_ELIMINATION' ||
        system === 'DOUBLE_ELIMINATION' ||
        (system === 'HYBRID' && m.phase === 2)
      );
      const pointsForWin = pointsApply ? config.swissPointsForWin : 0;
      const pointsForDraw = pointsApply ? config.swissPointsForDraw : 0;
      const pointsForLoss = pointsApply ? config.swissPointsForLoss : 0;

      if (m.isBye) {
        // A bye credits only the player given the seat, per the configured
        // byeResult; NONE credits nothing (the bye still counts as played).
        if (config.byeResult === 'NONE') continue;
        credit(
          m.player1Id ?? '',
          config.byeResult === 'DRAW' ? 'DRAW' : 'WIN',
          config.byeResult === 'DRAW' ? pointsForDraw : pointsForWin,
        );
        continue;
      }

      if (!m.player1Id || !m.player2Id) continue;

      if (!m.winnerId) {
        credit(m.player1Id, 'DRAW', pointsForDraw);
        credit(m.player2Id, 'DRAW', pointsForDraw);
        continue;
      }

      if (m.winnerId === m.player1Id) {
        credit(m.player1Id, 'WIN', pointsForWin);
        credit(m.player2Id, 'LOSS', pointsForLoss);
      } else {
        credit(m.player1Id, 'LOSS', pointsForLoss);
        credit(m.player2Id, 'WIN', pointsForWin);
      }
    }

    return record;
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

    const order = LeaderboardService.tiebreakOrder(tieBreakerOrder);
    const getters =
      LeaderboardService.tiebreakGetters<Omit<LeaderboardEntry, 'rank'>>();

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
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
          },
        },
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

    // The match record (W/L/D/points) derives from the completed matches too,
    // for the same reason: the denormalized stats rows drift when results are
    // rejected, reset, or re-reported, and nothing reconciles them.
    const records = await this.computeTournamentRecords(
      tournament,
      tournamentId,
    );

    const entries: Omit<LeaderboardEntry, 'rank'>[] = participants.map((p) => {
      const rec = records.get(p.userId);
      const gamesPlayed = rec?.gamesPlayed ?? 0;
      return {
        userId: p.userId,
        username: p.user?.username ?? 'Guest',
        displayName: p.user?.displayName ?? null,
        points: rec?.points ?? 0,
        wins: rec?.wins ?? 0,
        losses: rec?.losses ?? 0,
        draws: rec?.draws ?? 0,
        matchWinPct: gamesPlayed > 0 ? (rec?.wins ?? 0) / gamesPlayed : 0,
        omw: opponentStats.get(p.userId)?.omw ?? 0,
        oomw: opponentStats.get(p.userId)?.oomw ?? 0,
        gw: opponentStats.get(p.userId)?.gw ?? 0,
        ogw: opponentStats.get(p.userId)?.ogw ?? 0,
        avatarUrl: p.user?.avatarUrl ?? null,
      };
    });

    const sorted = this.sortEntries(entries, tieBreakerOrder);

    // DENSE ranking, matching the global board's 2026-09-16 change: a tie at
    // #2 reads "#2, #2" and the next distinct player is #3, not #4. This used
    // to be competition ranking (`i + 1`), so the same application ranked ties
    // two different ways depending on which table you were looking at.
    const ranked: LeaderboardEntry[] = [];
    let currentRank = 0;
    for (let i = 0; i < sorted.length; i++) {
      if (
        i === 0 ||
        this.rankChanged(sorted[i - 1], sorted[i], tieBreakerOrder)
      ) {
        currentRank += 1;
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
              select: {
                id: true,
                username: true,
                displayName: true,
                slug: true,
                avatarUrl: true,
              },
            },
          },
        })
      : await this.prisma.userGlobalStats.findMany({
          where: {
            user: { isGuest: false },
          },
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                slug: true,
                avatarUrl: true,
              },
            },
          },
        });

    const entries: Omit<GlobalLeaderboardEntry, 'rank'>[] = globalStats.map(
      (stat) => ({
        userId: stat.userId,
        username: stat.user?.username ?? 'Unknown',
        displayName: stat.user?.displayName ?? null,
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

    // Dense ranking: a tie shares one number, and the next distinct tier is
    // only ever one more than it — never `i + 1`, which would skip a number
    // for every player folded into the tie above it (two players tied at
    // #2 would otherwise push the next player to #4, with no #3 awarded).
    const ranked: GlobalLeaderboardEntry[] = [];
    let currentRank = 0;
    for (let i = 0; i < sorted.length; i++) {
      if (
        i === 0 ||
        this.rankChanged(sorted[i - 1], sorted[i], globalTieBreakerOrder)
      ) {
        currentRank += 1;
      }
      ranked.push({ rank: currentRank, ...sorted[i] });
    }

    return ranked;
  }

  // ─── GAMES ────────────────────────────────────────────────────

  /** The set of per-game boards worth showing, for the leaderboard's filter tabs.
   *
   *  This used to read `TournamentFormat.gameName` alone. That column is the
   *  DEPRECATED backfill source for `gameId` and nothing writes it any more, so
   *  once games became first-class (todo.md §5) it was always null: the endpoint
   *  returned [], the frontend hides the tab strip on an empty list, and every
   *  per-game board silently became unreachable even though the boards
   *  themselves still worked. Read the catalog instead, unioned with the game
   *  names that actually have stats so historical boards (including the retired
   *  "General") stay reachable.
   *
   *  `UserGameStats` is keyed by NAME, which is what `?game=` filters on — so the
   *  names returned here are exactly the values that board accepts. */
  async getGames(): Promise<string[]> {
    const [games, stats, legacyFormats] = await Promise.all([
      // The catalog, minus system rows (retired "General"): a game an admin has
      // created deserves a tab before anyone has finished a tournament in it.
      this.prisma.game.findMany({
        where: { isBuiltin: false },
        select: { name: true },
      }),
      // Any name that has a board behind it, whether or not the game still
      // exists in the catalog.
      this.prisma.userGameStats.findMany({
        select: { gameName: true },
        distinct: ['gameName'],
      }),
      this.prisma.tournamentFormat.findMany({
        where: { gameName: { not: null } },
        select: { gameName: true },
        distinct: ['gameName'],
      }),
    ]);

    const names = new Set<string>([
      ...games.map((g) => g.name),
      ...stats.map((s) => s.gameName),
      ...legacyFormats.map((f) => f.gameName as string),
    ]);
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  // ─── USER STATS ───────────────────────────────────────────────

  async getUserStats(userId: string): Promise<GlobalLeaderboardEntry | null> {
    const globalLeaderboard = await this.getGlobalLeaderboard();
    return globalLeaderboard.find((entry) => entry.userId === userId) || null;
  }
}
