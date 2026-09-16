import { DashboardService } from './dashboard.service';

/**
 * The dashboard is one response feeding two device views, so the things worth
 * guarding are the ones a view would silently render wrong: which side of a
 * match you are, how a position is ranked, and what happens when one section
 * of six fails.
 */

const ME = 'me-id';
const OTHER = 'other-id';

function participation(overrides: any = {}) {
  return {
    id: 'part-1',
    tournamentId: 't1',
    seed: 3,
    placement: null,
    stats: { wins: 2, losses: 1, draws: 0, points: 6 },
    tournament: {
      id: 't1',
      name: 'Harbour Winter Open',
      status: 'ONGOING',
      date: null,
      maxPlayers: 8,
      game: { id: 'g1', name: 'Chess', iconUrl: null },
      _count: { participants: 8 },
      rounds: [
        {
          roundNumber: 2,
          matches: [
            {
              id: 'm1',
              status: 'ONGOING',
              isBye: false,
              player1Id: ME,
              player2Id: OTHER,
              player1Score: 1,
              player2Score: 2,
              player1: { id: ME, username: 'me', displayName: 'Me', slug: 'me', avatarUrl: null, isGuest: false },
              player2: { id: OTHER, username: 'owen', displayName: 'Owen Blake', slug: 'owen', avatarUrl: null, isGuest: false },
            },
          ],
        },
      ],
      ...overrides,
    },
  };
}

function build(prismaOverrides: any = {}) {
  const prisma: any = {
    tournamentParticipant: {
      findMany: jest.fn().mockResolvedValue([participation()]),
    },
    userGame: { findMany: jest.fn().mockResolvedValue([]) },
    tournament: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    userAward: { findMany: jest.fn().mockResolvedValue([]) },
    galleryImage: { count: jest.fn().mockResolvedValue(0) },
    tournamentBuild: { count: jest.fn().mockResolvedValue(0) },
    user: { count: jest.fn().mockResolvedValue(0) },
    storeProduct: { count: jest.fn().mockResolvedValue(0), findFirst: jest.fn().mockResolvedValue(null) },
    ...prismaOverrides,
  };
  const leaderboard: any = {
    getUserStats: jest.fn().mockResolvedValue(null),
    getGlobalLeaderboard: jest.fn().mockResolvedValue([]),
  };
  return { service: new DashboardService(prisma, leaderboard), prisma, leaderboard };
}

describe('DashboardService', () => {
  it('reports the match from the viewer\'s side, not player1\'s', async () => {
    // The viewer is player1 and is LOSING 1-2. Read from the wrong side this
    // would tell them they are winning.
    const { service } = build({
      tournamentParticipant: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([participation()])
          .mockResolvedValueOnce([{ id: 'part-1', tournamentId: 't1', stats: { points: 6 } }]),
      },
    });

    const { entries } = await service.getDashboard(ME);

    expect(entries[0].myMatch).toMatchObject({
      myScore: 1,
      opponentScore: 2,
      opponent: expect.objectContaining({ displayName: 'Owen Blake' }),
    });
  });

  it('reads the opponent from player1 when the viewer is player2', async () => {
    const p = participation();
    const match = p.tournament.rounds[0].matches[0];
    // Swap sides wholesale — ids AND the player objects, the way the database
    // would actually have them.
    const asPlayer1 = match.player2;
    const asPlayer2 = match.player1;
    match.player1Id = OTHER;
    match.player2Id = ME;
    match.player1 = asPlayer1;
    match.player2 = asPlayer2;

    const { service } = build({
      tournamentParticipant: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([p])
          .mockResolvedValueOnce([{ id: 'part-1', tournamentId: 't1', stats: { points: 6 } }]),
      },
    });

    const { entries } = await service.getDashboard(ME);

    expect(entries[0].myMatch?.opponent?.displayName).toBe('Owen Blake');
    // Scores flip with the side: the viewer is player2, so 2 is theirs.
    expect(entries[0].myMatch?.myScore).toBe(2);
    expect(entries[0].myMatch?.opponentScore).toBe(1);
  });

  it('ranks positions densely, so a tie does not skip the next number', async () => {
    const { service } = build({
      tournamentParticipant: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([participation()])
          .mockResolvedValueOnce([
            { id: 'a', tournamentId: 't1', stats: { points: 9 } },
            { id: 'b', tournamentId: 't1', stats: { points: 9 } },
            { id: 'part-1', tournamentId: 't1', stats: { points: 6 } },
          ]),
      },
    });

    const { entries } = await service.getDashboard(ME);

    // Two players tied on 9 are both 1st, so the viewer on 6 is 2nd — not 3rd.
    expect(entries[0].standing?.position).toBe(2);
  });

  it('labels the round through the shared helper, including losers brackets', async () => {
    const p = participation();
    p.tournament.rounds[0].roundNumber = 102;

    const { service } = build({
      tournamentParticipant: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([p])
          .mockResolvedValueOnce([{ id: 'part-1', tournamentId: 't1', stats: { points: 6 } }]),
      },
    });

    const { entries } = await service.getDashboard(ME);
    expect(entries[0].round).toEqual({ number: 102, label: 'losers round 2' });
  });

  it('survives a failing section instead of losing the whole dashboard', async () => {
    const { service } = build({
      storeProduct: {
        count: jest.fn().mockRejectedValue(new Error('store is down')),
        findFirst: jest.fn().mockRejectedValue(new Error('store is down')),
      },
      tournamentParticipant: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([participation()])
          .mockResolvedValueOnce([{ id: 'part-1', tournamentId: 't1', stats: { points: 6 } }]),
      },
    });

    const result = await service.getDashboard(ME);

    expect(result.store).toEqual({ items: 0, featured: null });
    // The section that worked still arrives.
    expect(result.entries).toHaveLength(1);
  });

  it('asks only for tournaments the viewer is actively in and has not finished', async () => {
    const { service, prisma } = build();
    await service.getDashboard(ME);

    expect(prisma.tournamentParticipant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: ME,
          status: 'ACTIVE',
          tournament: { status: { not: 'COMPLETED' } },
        }),
      }),
    );
  });
});
