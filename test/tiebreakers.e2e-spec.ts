import { LeaderboardService } from '../src/leaderboard/leaderboard.service';

// OMW/OOMW were declared as tiebreakers and read by the sort, but nothing ever
// wrote them, so both always compared 0 to 0. They are now derived from the
// match graph on read.
describe('LeaderboardService opponent tiebreakers', () => {
  // Three players. A beat B, B beat C, C beat A - all on 1 win each, so points
  // tie and the tiebreaker has to do the work.
  const buildService = () => {
    const prisma = {
      match: {
        findMany: jest.fn().mockResolvedValue([
          { player1Id: 'a', player2Id: 'b', winnerId: 'a' },
          { player1Id: 'b', player2Id: 'c', winnerId: 'b' },
          { player1Id: 'c', player2Id: 'a', winnerId: 'c' },
          // d played only a and lost, so a faced a weaker field than b did.
          { player1Id: 'a', player2Id: 'd', winnerId: 'a' },
        ]),
      },
      tournamentParticipant: {
        findMany: jest.fn().mockResolvedValue([
          {
            userId: 'a',
            user: { id: 'a', username: 'A', avatarUrl: null },
            stats: { points: 3, wins: 2, losses: 1, draws: 0, winRate: 0.67 },
            tournament: { id: 't1', config: null, format: null },
          },
          {
            userId: 'b',
            user: { id: 'b', username: 'B', avatarUrl: null },
            stats: { points: 3, wins: 1, losses: 1, draws: 0, winRate: 0.5 },
            tournament: { id: 't1', config: null, format: null },
          },
        ]),
      },
      tournament: { findUnique: jest.fn().mockResolvedValue(null) },
    } as any;
    return { prisma, service: new LeaderboardService(prisma) };
  };

  it('computes a non-zero OMW instead of leaving it at 0', async () => {
    const { service } = buildService();
    const board = await service.getLeaderboard('t1');
    expect(board).toHaveLength(2);
    for (const entry of board) {
      expect(entry.omw).toBeGreaterThan(0);
      expect(entry.oomw).toBeGreaterThan(0);
    }
  });

  it('rates the player who faced the stronger field higher on OMW', async () => {
    const { service } = buildService();
    const board = await service.getLeaderboard('t1');
    const a = board.find((e) => e.userId === 'a')!;
    const b = board.find((e) => e.userId === 'b')!;
    // b's opponents were a (2 wins) and c (1 win); a's were b, c and d (0 wins),
    // so a's field was weaker.
    expect(b.omw).toBeGreaterThan(a.omw);
  });

  it('never lets a winless opponent count below the floor', async () => {
    const { service } = buildService();
    const board = await service.getLeaderboard('t1');
    // d lost every match, but contributes MIN_OPPONENT_WIN_PCT rather than 0.
    const a = board.find((e) => e.userId === 'a')!;
    expect(a.omw).toBeGreaterThanOrEqual(1 / 3);
  });
});

describe('LeaderboardService.tiebreakCriterion', () => {
  const service = new LeaderboardService({} as any);
  const entry = (over: Partial<any> = {}) =>
    ({
      userId: 'x',
      username: 'X',
      points: 3,
      wins: 1,
      losses: 1,
      draws: 0,
      matchWinPct: 0.5,
      omw: 0.5,
      oomw: 0.5,
      ...over,
    }) as any;

  it('names the tiebreaker that separated the two', () => {
    expect(
      service.tiebreakCriterion(entry({ omw: 0.6 }), entry(), ['omw', 'oomw']),
    ).toBe('omw');
  });

  it('falls through to the next tiebreaker when the first is equal', () => {
    expect(
      service.tiebreakCriterion(entry({ oomw: 0.7 }), entry(), ['omw', 'oomw']),
    ).toBe('oomw');
  });

  it('returns null when nothing separates them, so the caller can say so', () => {
    expect(
      service.tiebreakCriterion(entry(), entry(), ['omw', 'oomw']),
    ).toBeNull();
  });

  it('reports points when the entries are not actually tied', () => {
    expect(
      service.tiebreakCriterion(entry({ points: 6 }), entry(), ['omw']),
    ).toBe('points');
  });
});
