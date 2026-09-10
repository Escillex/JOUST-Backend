import { Injectable } from '@nestjs/common';
import {
  MatchStatus,
  ParticipantStatus,
  Prisma,
  Role,
  TournamentStatus,
} from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';

/** One month of platform activity. `month` is the first day of the month, ISO. */
export interface GrowthPoint {
  month: string;
  signups: number;
  tournamentsCreated: number;
  tournamentsCompleted: number;
  entries: number;
}

export interface GameBreakdownRow {
  gameId: string | null;
  name: string;
  retired: boolean;
  tournaments: number;
  completed: number;
  entries: number;
  players: number;
}

export interface FormatBreakdownRow {
  formatId: string | null;
  name: string;
  system: string | null;
  tournaments: number;
}

export interface AnalyticsOverview {
  generatedAt: string;
  months: number;
  summary: {
    users: {
      total: number;
      registered: number;
      guests: number;
      admins: number;
      organizers: number;
    };
    tournaments: {
      total: number;
      byStatus: Record<string, number>;
      completedWithoutTimestamp: number;
    };
    participation: {
      entries: number;
      uniquePlayers: number;
      averageFieldSize: number;
    };
    games: { catalog: number; retired: number };
  };
  growth: GrowthPoint[];
  games: GameBreakdownRow[];
  formats: FormatBreakdownRow[];
  systems: { system: string; tournaments: number }[];
  engagement: {
    participationDistribution: { bucket: string; players: number }[];
    returning: { players: number; repeat: number; returnRate: number };
    activity: { active30d: number; active90d: number; dormant: number };
  };
  operations: {
    matches: {
      total: number;
      completed: number;
      pending: number;
      ongoing: number;
      byes: number;
    };
    duration: {
      samples: number;
      unmeasured: number;
      medianMinutes: number | null;
      p90Minutes: number | null;
    };
    stalled: {
      matchesOngoingOver24h: number;
      tournamentsOngoingOver30d: number;
    };
    forfeits: { participants: number; rate: number };
  };
}

/** Admin analytics. Every figure is aggregated in SQL and returned as counts —
 *  the dashboard used to derive its four numbers by downloading the entire user
 *  and tournament tables into the browser, which is exactly the payload Core Rule
 *  8 warns about on venue Wi-Fi. Nothing here streams rows to the client. */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Postgres `count(*)` arrives as a BigInt through Prisma's raw client. */
  private static num(v: unknown): number {
    return typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
  }

  async getOverview(monthsRaw?: number): Promise<AnalyticsOverview> {
    // A nonsense window (0, negative, NaN from a junk query string) falls back to
    // the 12-month default rather than to a one-month view nobody asked for; a
    // real number is clamped to 1–24 so the payload can't be made unbounded.
    const requested = Number(monthsRaw);
    const months =
      Number.isFinite(requested) && requested >= 1
        ? Math.min(Math.trunc(requested), 24)
        : 12;
    // Inclusive window: the first day of the month `months - 1` back, so a
    // request for 12 returns this month plus the 11 before it.
    const since = new Date();
    since.setUTCDate(1);
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCMonth(since.getUTCMonth() - (months - 1));

    const [
      usersByGuest,
      admins,
      organizers,
      tournamentsByStatus,
      completedWithoutTimestamp,
      entries,
      uniquePlayers,
      gamesCatalog,
      gamesRetired,
      signupSeries,
      createdSeries,
      completedSeries,
      entrySeries,
      gameRows,
      formatRows,
      distribution,
      activity,
      operations,
    ] = await Promise.all([
      this.prisma.user.groupBy({ by: ['isGuest'], _count: { _all: true } }),
      this.prisma.user.count({ where: { roles: { has: Role.ADMIN } } }),
      this.prisma.user.count({ where: { roles: { has: Role.ORGANIZER } } }),
      this.prisma.tournament.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.tournament.count({
        where: { status: TournamentStatus.COMPLETED, completedAt: null },
      }),
      this.prisma.tournamentParticipant.count(),
      this.prisma
        .$queryRaw<
          { count: bigint }[]
        >(Prisma.sql`SELECT COUNT(DISTINCT "userId") AS count FROM "TournamentParticipant"`)
        .then((rows) => AnalyticsService.num(rows[0]?.count)),
      this.prisma.game.count({ where: { isBuiltin: false } }),
      this.prisma.game.count({ where: { isBuiltin: true } }),
      this.monthly(Prisma.sql`
        SELECT date_trunc('month', "createdAt") AS month, COUNT(*) AS value
        FROM "User"
        WHERE "isGuest" = false AND "createdAt" >= ${since}
        GROUP BY 1`),
      this.monthly(Prisma.sql`
        SELECT date_trunc('month', "createdAt") AS month, COUNT(*) AS value
        FROM "Tournament"
        WHERE "createdAt" >= ${since}
        GROUP BY 1`),
      this.monthly(Prisma.sql`
        SELECT date_trunc('month', "completedAt") AS month, COUNT(*) AS value
        FROM "Tournament"
        WHERE "completedAt" >= ${since}
        GROUP BY 1`),
      // Entries have no timestamp of their own (TournamentParticipant carries no
      // createdAt), so they are attributed to the month their tournament opened.
      this.monthly(Prisma.sql`
        SELECT date_trunc('month', t."createdAt") AS month, COUNT(*) AS value
        FROM "TournamentParticipant" p
        JOIN "Tournament" t ON t."id" = p."tournamentId"
        WHERE t."createdAt" >= ${since}
        GROUP BY 1`),
      this.gameBreakdown(),
      this.formatBreakdown(),
      this.participationDistribution(),
      this.activityWindows(),
      this.operations(),
    ]);

    const guests =
      AnalyticsService.num(usersByGuest.find((r) => r.isGuest)?._count._all) ||
      0;
    const registered =
      AnalyticsService.num(usersByGuest.find((r) => !r.isGuest)?._count._all) ||
      0;

    const byStatus: Record<string, number> = {};
    for (const row of tournamentsByStatus) {
      byStatus[row.status] = AnalyticsService.num(row._count._all);
    }
    const totalTournaments = Object.values(byStatus).reduce((a, b) => a + b, 0);

    const growth = this.buildGrowth(since, months, {
      signups: signupSeries,
      tournamentsCreated: createdSeries,
      tournamentsCompleted: completedSeries,
      entries: entrySeries,
    });

    const repeat = distribution
      .filter((d) => d.bucket !== '1')
      .reduce((a, d) => a + d.players, 0);
    const playersWithAny = distribution.reduce((a, d) => a + d.players, 0);

    return {
      generatedAt: new Date().toISOString(),
      months,
      summary: {
        users: {
          total: registered + guests,
          registered,
          guests,
          admins,
          organizers,
        },
        tournaments: {
          total: totalTournaments,
          byStatus,
          completedWithoutTimestamp,
        },
        participation: {
          entries,
          uniquePlayers,
          averageFieldSize:
            totalTournaments > 0
              ? Math.round((entries / totalTournaments) * 10) / 10
              : 0,
        },
        games: { catalog: gamesCatalog, retired: gamesRetired },
      },
      growth,
      games: gameRows,
      formats: formatRows,
      systems: this.rollUpSystems(formatRows),
      engagement: {
        participationDistribution: distribution,
        returning: {
          players: playersWithAny,
          repeat,
          returnRate:
            playersWithAny > 0
              ? Math.round((repeat / playersWithAny) * 1000) / 10
              : 0,
        },
        activity,
      },
      operations,
    };
  }

  /** Runs a `month, value` aggregate and returns it keyed by ISO month. */
  private async monthly(query: Prisma.Sql): Promise<Map<string, number>> {
    const rows =
      await this.prisma.$queryRaw<{ month: Date; value: bigint }[]>(query);
    const out = new Map<string, number>();
    for (const row of rows) {
      out.set(
        new Date(row.month).toISOString().slice(0, 7),
        AnalyticsService.num(row.value),
      );
    }
    return out;
  }

  /** Densifies the series: a month with no activity must appear as a zero, not
   *  be missing, or the chart silently compresses quiet periods away. */
  private buildGrowth(
    since: Date,
    months: number,
    series: Record<string, Map<string, number>>,
  ): GrowthPoint[] {
    const out: GrowthPoint[] = [];
    for (let i = 0; i < months; i++) {
      const d = new Date(since);
      d.setUTCMonth(d.getUTCMonth() + i);
      const key = d.toISOString().slice(0, 7);
      out.push({
        month: key,
        signups: series.signups.get(key) ?? 0,
        tournamentsCreated: series.tournamentsCreated.get(key) ?? 0,
        tournamentsCompleted: series.tournamentsCompleted.get(key) ?? 0,
        entries: series.entries.get(key) ?? 0,
      });
    }
    return out;
  }

  /** Tournaments, completions and field size per game. Tournaments with no game
   *  (legacy rows predating the catalog) are reported under a null id rather than
   *  dropped, so the totals reconcile with the summary. */
  private async gameBreakdown(): Promise<GameBreakdownRow[]> {
    const rows = await this.prisma.$queryRaw<
      {
        gameId: string | null;
        name: string | null;
        retired: boolean | null;
        tournaments: bigint;
        completed: bigint;
        entries: bigint;
        players: bigint;
      }[]
    >(Prisma.sql`
      SELECT g."id"        AS "gameId",
             g."name"      AS "name",
             g."isBuiltin" AS "retired",
             COUNT(DISTINCT t."id")                                    AS "tournaments",
             COUNT(DISTINCT t."id") FILTER (WHERE t."status" = 'COMPLETED') AS "completed",
             COUNT(p."id")                                             AS "entries",
             COUNT(DISTINCT p."userId")                                AS "players"
      FROM "Tournament" t
      LEFT JOIN "Game" g ON g."id" = t."gameId"
      LEFT JOIN "TournamentParticipant" p ON p."tournamentId" = t."id"
      GROUP BY g."id", g."name", g."isBuiltin"
      ORDER BY "tournaments" DESC, g."name" ASC`);

    return rows.map((r) => ({
      gameId: r.gameId,
      name: r.name ?? 'No game set',
      retired: !!r.retired,
      tournaments: AnalyticsService.num(r.tournaments),
      completed: AnalyticsService.num(r.completed),
      entries: AnalyticsService.num(r.entries),
      players: AnalyticsService.num(r.players),
    }));
  }

  private async formatBreakdown(): Promise<FormatBreakdownRow[]> {
    const rows = await this.prisma.$queryRaw<
      {
        formatId: string | null;
        name: string | null;
        system: string | null;
        tournaments: bigint;
      }[]
    >(Prisma.sql`
      SELECT f."id"     AS "formatId",
             f."name"   AS "name",
             f."system" AS "system",
             COUNT(t."id") AS "tournaments"
      FROM "Tournament" t
      LEFT JOIN "TournamentFormat" f ON f."id" = t."formatId"
      GROUP BY f."id", f."name", f."system"
      ORDER BY "tournaments" DESC, f."name" ASC`);

    return rows.map((r) => ({
      formatId: r.formatId,
      name: r.name ?? 'No format set',
      system: r.system,
      tournaments: AnalyticsService.num(r.tournaments),
    }));
  }

  /** Structure is game-agnostic, so the system roll-up answers a different
   *  question than the preset one: which bracket shapes organizers reach for. */
  private rollUpSystems(
    formats: FormatBreakdownRow[],
  ): { system: string; tournaments: number }[] {
    const map = new Map<string, number>();
    for (const f of formats) {
      const key = f.system ?? 'UNKNOWN';
      map.set(key, (map.get(key) ?? 0) + f.tournaments);
    }
    return [...map.entries()]
      .map(([system, tournaments]) => ({ system, tournaments }))
      .sort((a, b) => b.tournaments - a.tournaments);
  }

  /** How many tournaments each non-guest player has entered, bucketed. Guests
   *  are excluded here as everywhere else: they are deleted after the event, so
   *  counting them would report churn the platform manufactures itself. */
  private async participationDistribution(): Promise<
    { bucket: string; players: number }[]
  > {
    const rows = await this.prisma.$queryRaw<
      { bucket: string; players: bigint }[]
    >(Prisma.sql`
      SELECT CASE
               WHEN c = 1 THEN '1'
               WHEN c BETWEEN 2 AND 4 THEN '2-4'
               WHEN c BETWEEN 5 AND 9 THEN '5-9'
               ELSE '10+'
             END AS bucket,
             COUNT(*) AS players
      FROM (
        SELECT p."userId", COUNT(*) AS c
        FROM "TournamentParticipant" p
        JOIN "User" u ON u."id" = p."userId"
        WHERE u."isGuest" = false
        GROUP BY p."userId"
      ) per_user
      GROUP BY bucket`);

    const order = ['1', '2-4', '5-9', '10+'];
    const found = new Map(
      rows.map((r) => [r.bucket, AnalyticsService.num(r.players)]),
    );
    return order.map((bucket) => ({
      bucket,
      players: found.get(bucket) ?? 0,
    }));
  }

  /** Operational health: how matches are actually flowing.
   *
   *  Duration is measured from `Match.startedAt` to `Match.completedAt` over
   *  real, played matches only. Byes, walkovers and dead matches complete the
   *  instant they are created — including them would drag every average toward
   *  zero — and matches finished without ever opening the tracker have no start
   *  stamp at all, so they are reported as `unmeasured` rather than counted as
   *  instant. Median and p90 rather than a mean: one match left open overnight
   *  would otherwise move the headline number more than the other fifty.
   */
  private async operations() {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      byStatus,
      byes,
      durations,
      unmeasured,
      stalledMatches,
      stalledTournaments,
      forfeits,
      entries,
    ] = await Promise.all([
      this.prisma.match.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.match.count({ where: { isBye: true } }),
      // Quantiles in SQL. Pulling one row per match back to compute them here
      // would ship the whole match table over the wire on every dashboard load
      // — the exact payload shape this endpoint exists to avoid.
      this.prisma.$queryRaw<
        { samples: bigint; median: number | null; p90: number | null }[]
      >(Prisma.sql`
          SELECT COUNT(*) AS samples,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY mins) AS median,
                 percentile_cont(0.9) WITHIN GROUP (ORDER BY mins) AS p90
          FROM (
            SELECT EXTRACT(EPOCH FROM ("completedAt" - "startedAt")) / 60 AS mins
            FROM "Match"
            WHERE "isBye" = false
              AND "startedAt" IS NOT NULL
              AND "completedAt" IS NOT NULL
              AND "completedAt" > "startedAt"
          ) timed`),
      this.prisma.match.count({
        where: {
          status: MatchStatus.COMPLETED,
          isBye: false,
          OR: [{ startedAt: null }, { completedAt: null }],
        },
      }),
      this.prisma.match.count({
        where: { status: MatchStatus.ONGOING, startedAt: { lt: dayAgo } },
      }),
      this.prisma.tournament.count({
        where: {
          status: TournamentStatus.ONGOING,
          createdAt: { lt: monthAgo },
        },
      }),
      this.prisma.tournamentParticipant.count({
        where: { status: ParticipantStatus.FORFEITED },
      }),
      this.prisma.tournamentParticipant.count(),
    ]);

    const counts: Record<string, number> = {};
    for (const row of byStatus) {
      counts[row.status] = AnalyticsService.num(row._count._all);
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);

    // percentile_cont returns NULL over an empty set, which is exactly the
    // contract here: no timed matches means "unknown", never zero.
    const timing = durations[0];
    // Two decimals, not one: a tenth of a minute is 6-second granularity, which
    // rounds a genuinely short match to a flat 0 and renders as "0s".
    const round2 = (v: number | null | undefined) =>
      v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100;

    return {
      matches: {
        total,
        completed: counts[MatchStatus.COMPLETED] ?? 0,
        pending: counts[MatchStatus.PENDING] ?? 0,
        ongoing: counts[MatchStatus.ONGOING] ?? 0,
        byes,
      },
      duration: {
        samples: AnalyticsService.num(timing?.samples),
        unmeasured,
        medianMinutes: round2(timing?.median),
        p90Minutes: round2(timing?.p90),
      },
      stalled: {
        matchesOngoingOver24h: stalledMatches,
        tournamentsOngoingOver30d: stalledTournaments,
      },
      forfeits: {
        participants: forfeits,
        rate: entries > 0 ? Math.round((forfeits / entries) * 1000) / 10 : 0,
      },
    };
  }

  /** Recency of play, from UserGlobalStats.updatedAt — it is written whenever a
   *  match result lands, which is the closest thing to a "last active" stamp the
   *  schema keeps. Dormant = has a stats row but nothing in 90 days. */
  private async activityWindows() {
    const now = Date.now();
    const d30 = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const d90 = new Date(now - 90 * 24 * 60 * 60 * 1000);
    const [active30d, active90d, total] = await Promise.all([
      this.prisma.userGlobalStats.count({ where: { updatedAt: { gte: d30 } } }),
      this.prisma.userGlobalStats.count({ where: { updatedAt: { gte: d90 } } }),
      this.prisma.userGlobalStats.count(),
    ]);
    return { active30d, active90d, dormant: total - active90d };
  }
}
