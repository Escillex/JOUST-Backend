import { UserService } from '../src/user/user.service';

/**
 * The "View all matches" page (2026-09-16): a player's history grouped by
 * tournament, newest first, paged by tournament, each match from their side.
 */
const ME = 'me';
const person = (id: string, name: string) => ({
  id,
  username: name.toLowerCase(),
  displayName: name,
  slug: name.toLowerCase(),
  avatarUrl: null,
});

function build() {
  const tournaments = [
    {
      id: 't-old',
      name: 'Spring Prelims',
      date: new Date('2026-01-20'),
      createdAt: new Date('2026-01-01'),
      status: 'COMPLETED',
      format: { system: 'SWISS' },
      game: { name: 'Pokémon TCG' },
    },
    // No date: falls back to createdAt, the profile's rule.
    {
      id: 't-new',
      name: 'Summer Clash',
      date: null,
      createdAt: new Date('2026-06-16'),
      status: 'COMPLETED',
      format: { system: 'SINGLE_ELIMINATION' },
      game: { name: 'Beyblade' },
    },
    {
      id: 't-mid',
      name: 'Northgate Cup',
      date: new Date('2026-03-02'),
      createdAt: new Date('2026-02-01'),
      status: 'ONGOING',
      format: null,
      game: null,
    },
  ];
  const matches = [
    {
      id: 'm1',
      player1Id: ME,
      player2Id: 'o1',
      player1Score: 2,
      player2Score: 1,
      winnerId: ME,
      p1Name: null,
      p2Name: null,
      completedAt: new Date(),
      createdAt: new Date(),
      round: { roundNumber: 1, tournamentId: 't-new' },
      player1: person(ME, 'Me'),
      player2: person('o1', 'Owen Blake'),
    },
    {
      id: 'm2',
      player1Id: 'o2',
      player2Id: ME,
      player1Score: 1,
      player2Score: 0,
      winnerId: 'o2',
      p1Name: null,
      p2Name: null,
      completedAt: null,
      createdAt: new Date(),
      round: { roundNumber: 101, tournamentId: 't-new' },
      player1: person('o2', 'Nadia Petrov'),
      player2: person(ME, 'Me'),
    },
    // A deleted opponent: no account, only the burned-in name.
    {
      id: 'm3',
      player1Id: null,
      player2Id: ME,
      player1Score: 1,
      player2Score: 1,
      winnerId: null,
      p1Name: 'Gone Player',
      p2Name: null,
      completedAt: new Date(),
      createdAt: new Date(),
      round: { roundNumber: 200, tournamentId: 't-mid' },
      player1: null,
      player2: person(ME, 'Me'),
    },
  ];
  const prisma: any = {
    user: { findFirst: jest.fn(async () => ({ id: ME })) },
    tournament: {
      findMany: jest.fn(async ({ where }: any) =>
        where.id
          ? tournaments.filter((t) => where.id.in.includes(t.id))
          : tournaments.map(({ id, date, createdAt }) => ({
              id,
              date,
              createdAt,
            })),
      ),
    },
    match: {
      findMany: jest.fn(async ({ where }: any) =>
        matches.filter((m) =>
          where.round.tournamentId.in.includes(m.round.tournamentId),
        ),
      ),
    },
    tournamentParticipant: {
      findMany: jest.fn(async () => [{ tournamentId: 't-new', placement: 3 }]),
    },
  };
  return { svc: new UserService(prisma), prisma };
}

describe('match history by tournament', () => {
  it('orders tournaments newest first, using createdAt when there is no date', async () => {
    const { svc } = build();
    const res = await svc.getMatchHistory('me');
    expect(res.groups.map((g) => g.tournament.id)).toEqual([
      't-new',
      't-mid',
      't-old',
    ]);
    expect(res.groups[0].tournament).toMatchObject({
      name: 'Summer Clash',
      game: 'Beyblade',
      format: 'SINGLE_ELIMINATION',
      placement: 3,
    });
    expect(res.groups[1].tournament.placement).toBeNull();
  });

  it("tells each match from this player's side, with a round name", async () => {
    const { svc } = build();
    const [summer, northgate] = (await svc.getMatchHistory('me')).groups;
    expect(summer.matches[0]).toMatchObject({
      result: 'win',
      myScore: 2,
      oppScore: 1,
      roundLabel: 'round 1',
      opponent: { name: 'Owen Blake', slug: 'owen blake' },
    });
    expect(summer.matches[1]).toMatchObject({
      result: 'loss',
      myScore: 0,
      oppScore: 1,
      roundLabel: 'losers round 1',
      opponent: { name: 'Nadia Petrov' },
    });
    expect(northgate.matches[0]).toMatchObject({
      result: 'draw',
      roundLabel: 'grand final',
      opponent: { id: null, name: 'Gone Player' },
    });
  });

  it('pages by tournament and says where the next page starts', async () => {
    const { svc } = build();
    const first = await svc.getMatchHistory('me', 0, 2);
    expect(first.groups).toHaveLength(2);
    expect(first).toMatchObject({
      totalTournaments: 3,
      offset: 0,
      nextOffset: 2,
    });
    const last = await svc.getMatchHistory('me', 2, 2);
    expect(last.groups.map((g) => g.tournament.id)).toEqual(['t-old']);
    expect(last.nextOffset).toBeNull();
  });

  it('clamps a silly page size rather than sending a whole career at once', async () => {
    const { svc, prisma } = build();
    await svc.getMatchHistory('me', -5, 10_000);
    const idsAsked = prisma.tournament.findMany.mock.calls[1][0].where.id.in;
    expect(idsAsked.length).toBeLessThanOrEqual(20);
  });
});
