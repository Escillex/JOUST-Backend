import { SearchService } from './search.service';
import type { PrismaService } from 'prisma/prisma.service';

/**
 * `GET /search` and `/search/spotlight` are unguarded, so what they refuse to
 * return is a privacy contract, not a filter: guests have no lasting profile
 * and unlisted tournaments must not leak through an endpoint nobody has to
 * sign in to reach.
 *
 * The ranking is the other half — the omnibox is only useful if typing "Mira"
 * puts Mira first, which is a pure function of the rows Prisma returns.
 */

const TOURNAMENT_ROWS: any[] = [];

function harness(users: any[] = [], tournaments: any[] = TOURNAMENT_ROWS) {
  const prisma = {
    user: { findMany: jest.fn().mockResolvedValue(users) },
    tournament: { findMany: jest.fn().mockResolvedValue(tournaments) },
  };
  return {
    service: new SearchService(prisma as unknown as PrismaService),
    prisma,
  };
}

const person = (over: Partial<any> = {}) => ({
  id: over.id ?? 'u1',
  username: over.username ?? 'someone',
  displayName: over.displayName ?? null,
  slug: over.slug ?? 'someone',
  avatarUrl: null,
  globalStats: over.globalStats ?? null,
  ...over,
});

describe('SearchService.search — the empty query', () => {
  it.each([undefined, '', '   '])(
    'returns nothing for %p without querying',
    async (q) => {
      const h = harness();
      await expect(h.service.search(q as any)).resolves.toEqual({
        users: [],
        tournaments: [],
      });
      expect(h.prisma.user.findMany).not.toHaveBeenCalled();
      expect(h.prisma.tournament.findMany).not.toHaveBeenCalled();
    },
  );

  it('searches on a single character, once trimmed', async () => {
    const h = harness();
    await h.service.search('  m  ');
    expect(h.prisma.user.findMany).toHaveBeenCalled();
    const where = h.prisma.user.findMany.mock.calls[0][0].where;
    expect(where.OR[0].username.contains).toBe('m');
  });
});

describe('SearchService.search — what it refuses to expose', () => {
  it('never returns guests', async () => {
    const h = harness();
    await h.service.search('mira');
    expect(h.prisma.user.findMany.mock.calls[0][0].where.isGuest).toBe(false);
  });

  it('never returns unlisted tournaments', async () => {
    const h = harness();
    await h.service.search('winter');
    expect(h.prisma.tournament.findMany.mock.calls[0][0].where.isPrivate).toBe(
      false,
    );
  });

  it('matches case-insensitively on both the handle and the display name', async () => {
    const h = harness();
    await h.service.search('Mira');
    const or = h.prisma.user.findMany.mock.calls[0][0].where.OR;
    expect(or).toEqual([
      { username: { contains: 'Mira', mode: 'insensitive' } },
      { displayName: { contains: 'Mira', mode: 'insensitive' } },
    ]);
  });
});

describe('SearchService.search — people ranking', () => {
  it('puts a prefix match ahead of a mid-string match', async () => {
    const h = harness([
      person({ id: 'mid', username: 'calder-mira' }),
      person({ id: 'start', username: 'mira-calder' }),
    ]);
    const { users } = await h.service.search('mira');
    expect(users.map((u) => u.id)).toEqual(['start', 'mid']);
  });

  it('counts a prefix on EITHER name — the handle or the display name', async () => {
    // Mira's handle is mira-calder, but "Mira Calder" is what people type.
    const h = harness([
      person({ id: 'mid', username: 'a-mira', displayName: 'A Mira' }),
      person({
        id: 'display',
        username: 'mc-2481',
        displayName: 'Mira Calder',
      }),
    ]);
    const { users } = await h.service.search('mira');
    expect(users[0].id).toBe('display');
  });

  it('breaks a tie on tournaments won, then on global points', async () => {
    const stats = (won: number, points: number) => ({
      tournamentsPlayed: 10,
      tournamentsWon: won,
      globalPoints: points,
    });
    const h = harness([
      person({ id: 'low', username: 'mira-c', globalStats: stats(1, 50) }),
      person({ id: 'points', username: 'mira-b', globalStats: stats(3, 90) }),
      person({ id: 'wins', username: 'mira-a', globalStats: stats(3, 200) }),
    ]);
    const { users } = await h.service.search('mira');
    expect(users.map((u) => u.id)).toEqual(['wins', 'points', 'low']);
  });

  it('treats a player with no stats row as zeroed rather than dropping them', async () => {
    const h = harness([
      person({ id: 'new', username: 'mira-new', globalStats: null }),
    ]);
    const { users } = await h.service.search('mira');
    expect(users[0]).toMatchObject({
      id: 'new',
      tournamentsPlayed: 0,
      tournamentsWon: 0,
      globalPoints: 0,
    });
  });

  it('tolerates a null handle or display name while ranking', async () => {
    const h = harness([
      person({ id: 'a', username: null, displayName: 'Mira Calder' }),
      person({ id: 'b', username: 'mira-b', displayName: null }),
    ]);
    const { users } = await h.service.search('mira');
    expect(users).toHaveLength(2);
  });

  it('keeps the best 8 of the 20 it fetches', async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      person({ id: `u${i}`, username: `zz-mira-${i}` }),
    );
    // One prefix match hiding at the end of the fetch window.
    many[19] = person({ id: 'best', username: 'mira-best' });
    const h = harness(many);
    const { users } = await h.service.search('mira');
    expect(users).toHaveLength(8);
    expect(users[0].id).toBe('best');
  });

  it('does not leak the internal ranking field into the response', async () => {
    const h = harness([person({ id: 'u1', username: 'mira' })]);
    const { users } = await h.service.search('mira');
    expect(users[0]).not.toHaveProperty('_starts');
    expect(Object.keys(users[0]).sort()).toEqual(
      [
        'avatarUrl',
        'displayName',
        'globalPoints',
        'id',
        'slug',
        'tournamentsPlayed',
        'tournamentsWon',
        'username',
      ].sort(),
    );
  });
});

describe('SearchService.search — tournament results', () => {
  const t = (over: Partial<any> = {}) => ({
    id: 't1',
    name: 'Winter Open',
    slug: 'winter-open',
    status: 'OPEN',
    date: new Date('2026-10-01T18:00:00.000Z'),
    game: { name: 'Chess' },
    system: null,
    format: { system: 'SWISS' },
    ...over,
  });

  it('flattens the game name and serialises the date', async () => {
    const h = harness([], [t()]);
    const { tournaments } = await h.service.search('winter');
    expect(tournaments[0]).toEqual({
      id: 't1',
      name: 'Winter Open',
      slug: 'winter-open',
      status: 'OPEN',
      date: '2026-10-01T18:00:00.000Z',
      game: 'Chess',
      format: 'SWISS',
    });
  });

  it('reports the tournament’s own system snapshot ahead of the live preset', async () => {
    // A started tournament must not depend on its preset still existing.
    const h = harness(
      [],
      [t({ system: 'HYBRID', format: { system: 'SWISS' } })],
    );
    const { tournaments } = await h.service.search('winter');
    expect(tournaments[0].format).toBe('HYBRID');
  });

  it('survives a deleted preset and a missing game', async () => {
    const h = harness(
      [],
      [t({ system: 'SWISS', format: null, game: null, date: null })],
    );
    const { tournaments } = await h.service.search('winter');
    expect(tournaments[0]).toMatchObject({
      game: null,
      format: 'SWISS',
      date: null,
    });
  });

  it('reports null rather than a placeholder when nothing names the system', async () => {
    const h = harness([], [t({ system: null, format: null })]);
    expect((await h.service.search('winter')).tournaments[0].format).toBeNull();
  });
});

describe('SearchService.spotlight', () => {
  const champ = (over: Partial<any> = {}) => ({
    id: 't1',
    name: 'Winter Open',
    slug: 'winter-open',
    date: new Date('2026-10-01T18:00:00.000Z'),
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    game: { name: 'Chess' },
    winner: {
      id: 'u1',
      username: 'mira-calder',
      displayName: 'Mira Calder',
      slug: 'mira-calder',
      avatarUrl: null,
    },
    ...over,
  });

  it('asks only for finished, public tournaments won by a real account', async () => {
    const h = harness([], []);
    await h.service.spotlight();
    const args = h.prisma.tournament.findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      isPrivate: false,
      status: 'COMPLETED',
      winnerId: { not: null },
      winner: { isGuest: false },
    });
    expect(args.take).toBe(6);
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('shapes a champion row for the community landing state', async () => {
    const h = harness([], [champ()]);
    const { recentChampions } = await h.service.spotlight();
    expect(recentChampions[0]).toEqual({
      tournamentId: 't1',
      tournamentName: 'Winter Open',
      tournamentSlug: 'winter-open',
      date: '2026-10-01T18:00:00.000Z',
      game: 'Chess',
      winner: {
        id: 'u1',
        username: 'mira-calder',
        displayName: 'Mira Calder',
        slug: 'mira-calder',
        avatarUrl: null,
      },
    });
  });

  it('falls back to createdAt for a tournament with no scheduled date', async () => {
    const h = harness([], [champ({ date: null })]);
    const { recentChampions } = await h.service.spotlight();
    expect(recentChampions[0].date).toBe('2026-09-01T00:00:00.000Z');
  });

  it('returns an empty feed rather than failing on a fresh deployment', async () => {
    const h = harness([], []);
    await expect(h.service.spotlight()).resolves.toEqual({
      recentChampions: [],
    });
  });
});
