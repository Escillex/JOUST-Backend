import { AnalyticsService } from '../src/analytics/analytics.service';

// The SQL itself is exercised live; what is worth pinning here is the shaping
// around it — the window clamp, the densified month series (a quiet month must
// appear as a zero, not vanish), and the roll-ups that feed the charts.
describe('AnalyticsService', () => {
  const iso = (d: Date) => d.toISOString().slice(0, 7);

  // Raw responses are matched by a distinctive fragment of their SQL, not by
  // call order: an earlier version keyed off position in the Promise.all, so
  // adding one query silently shifted every fixture onto the wrong assertion.
  const buildService = (raw: Record<string, Record<string, unknown>[]> = {}) => {
    const pick = (query: any) => {
      const sql = (query?.strings ?? []).join(' ');
      const hit = Object.entries(raw).find(([token]) => sql.includes(token));
      return hit ? hit[1] : [];
    };
    const prisma = {
      user: {
        groupBy: jest.fn().mockResolvedValue([
          { isGuest: false, _count: { _all: 4 } },
          { isGuest: true, _count: { _all: 6 } },
        ]),
        count: jest.fn().mockResolvedValue(1),
      },
      tournament: {
        groupBy: jest.fn().mockResolvedValue([
          { status: 'COMPLETED', _count: { _all: 3 } },
          { status: 'ONGOING', _count: { _all: 1 } },
        ]),
        count: jest.fn().mockResolvedValue(2),
      },
      tournamentParticipant: {
        count: jest.fn().mockResolvedValue(10),
        findMany: jest.fn().mockResolvedValue([{ userId: 'a' }, { userId: 'b' }]),
      },
      game: { count: jest.fn().mockResolvedValue(2) },
      userGlobalStats: { count: jest.fn().mockResolvedValue(5) },
      match: {
        groupBy: jest.fn().mockResolvedValue([
          { status: 'COMPLETED', _count: { _all: 8 } },
          { status: 'ONGOING', _count: { _all: 2 } },
          { status: 'PENDING', _count: { _all: 3 } },
        ]),
        count: jest.fn().mockResolvedValue(1),
      },
      $queryRaw: jest.fn().mockImplementation(async (query: any) => pick(query)),
    } as any;
    return { prisma, service: new AnalyticsService(prisma) };
  };

  it('clamps the reporting window and returns one point per month', async () => {
    const { service } = buildService();
    // A nonsense window falls back to the default rather than to a 1-month view.
    await expect(service.getOverview(0)).resolves.toMatchObject({ months: 12 });
    await expect(service.getOverview(NaN)).resolves.toMatchObject({ months: 12 });
    await expect(service.getOverview(999)).resolves.toMatchObject({ months: 24 });
    await expect(service.getOverview(1)).resolves.toMatchObject({ months: 1 });
    const twelve = await service.getOverview(12);
    expect(twelve.months).toBe(12);
    expect(twelve.growth).toHaveLength(12);
  });

  it('densifies quiet months to zero instead of dropping them', async () => {
    const thisMonth = new Date();
    thisMonth.setUTCDate(1);
    // Only the current month has signups; the other two must still be present.
    const { service } = buildService({
      'FROM "User"': [{ month: thisMonth, value: BigInt(7) }],
    });
    const out = await service.getOverview(3);
    expect(out.growth.map((p) => p.month)).toHaveLength(3);
    expect(out.growth[out.growth.length - 1]).toMatchObject({
      month: iso(thisMonth),
      signups: 7,
    });
    expect(out.growth[0].signups).toBe(0);
    expect(out.growth[0].entries).toBe(0);
  });

  it('reports a tournament with no game rather than dropping it', async () => {
    const { service } = buildService({
      'LEFT JOIN "Game"': [
        { gameId: 'g1', name: 'Chess', retired: false, tournaments: BigInt(4), completed: BigInt(2), entries: BigInt(20), players: BigInt(9) },
        { gameId: null, name: null, retired: null, tournaments: BigInt(1), completed: BigInt(0), entries: BigInt(2), players: BigInt(2) },
      ],
    });
    const out = await service.getOverview(6);
    expect(out.games).toHaveLength(2);
    expect(out.games[1]).toMatchObject({ gameId: null, name: 'No game set', tournaments: 1 });
  });

  it('rolls formats up into bracket structures', async () => {
    const { service } = buildService({
      'LEFT JOIN "TournamentFormat"': [
        { formatId: 'f1', name: 'Swiss A', system: 'SWISS', tournaments: BigInt(3) },
        { formatId: 'f2', name: 'Swiss B', system: 'SWISS', tournaments: BigInt(2) },
        { formatId: 'f3', name: 'Cup', system: 'SINGLE_ELIMINATION', tournaments: BigInt(4) },
      ],
    });
    const out = await service.getOverview(6);
    expect(out.systems).toEqual([
      { system: 'SWISS', tournaments: 5 },
      { system: 'SINGLE_ELIMINATION', tournaments: 4 },
    ]);
  });

  it('always returns the four participation buckets, in order, and a return rate', async () => {
    const { service } = buildService({
      per_user: [
        { bucket: '1', players: BigInt(6) },
        { bucket: '5-9', players: BigInt(2) },
      ],
    });
    const out = await service.getOverview(6);
    expect(out.engagement.participationDistribution.map((d) => d.bucket)).toEqual([
      '1', '2-4', '5-9', '10+',
    ]);
    expect(out.engagement.participationDistribution[1].players).toBe(0);
    // 2 of 8 players entered more than one tournament.
    expect(out.engagement.returning).toEqual({ players: 8, repeat: 2, returnRate: 25 });
  });

  describe('operational health', () => {
    it('reports the quantiles SQL computed, rounded to two decimals', async () => {
      const { prisma, service } = buildService({
        percentile_cont: [{ samples: BigInt(10), median: 11.04, p90: 82.36 }],
      });
      const out = await service.getOverview(6);
      expect(out.operations.duration.samples).toBe(10);
      expect(out.operations.duration.medianMinutes).toBe(11.04);
      expect(out.operations.duration.p90Minutes).toBe(82.36);
      // The exclusions live in SQL, so assert the query still carries them —
      // dropping one would quietly pull byes (instant) into the timing sample.
      const sql = prisma.$queryRaw.mock.calls
        .map((c: any[]) => (c[0]?.strings ?? []).join(' '))
        .find((q: string) => q.includes('percentile_cont'));
      expect(sql).toContain('percentile_cont');
      expect(sql).toContain('"isBye" = false');
      expect(sql).toContain('"startedAt" IS NOT NULL');
      expect(sql).toContain('"completedAt" IS NOT NULL');
    });

    it('returns nulls rather than zero when nothing has been timed', async () => {
      // percentile_cont over an empty set is NULL, and that must survive as
      // "unknown" instead of being coerced to a plausible-looking 0.
      const { service } = buildService({
        percentile_cont: [{ samples: BigInt(0), median: null, p90: null }],
      });
      const out = await service.getOverview(6);
      expect(out.operations.duration).toMatchObject({
        samples: 0,
        medianMinutes: null,
        p90Minutes: null,
      });
    });

    it('derives the forfeit rate from entries', async () => {
      const { prisma, service } = buildService();
      // forfeited participants = 1 (match.count mock), entries = 10.
      prisma.tournamentParticipant.count = jest
        .fn()
        .mockResolvedValueOnce(10) // summary entries
        .mockResolvedValueOnce(4) // forfeited
        .mockResolvedValueOnce(40); // entries for the rate
      const out = await service.getOverview(6);
      expect(out.operations.forfeits).toEqual({ participants: 4, rate: 10 });
    });
  });
});
