import { LeaderboardService } from './leaderboard.service';

/**
 * GW% and OGW% (docs/tournament-views-plan.md, phase 1).
 *
 * Swiss could not separate players the way most best-of-three formats do,
 * because no game-level tiebreaker existed. These guard the parts that are easy
 * to get subtly wrong: which column counts games, whose floor applies, and that
 * a configured order actually sorts by the new fields rather than silently
 * falling through.
 */

const T = 'tournament-1';

/** Two players, one match, reported 2–1 in games. */
function prismaWith(matches: any[], participants: any[], byes: any[] = []) {
  return {
    match: {
      // Two queries now: real matches, then byes (own record only).
      findMany: jest
        .fn()
        .mockImplementation((args: any) =>
          Promise.resolve(args?.where?.isBye === true ? byes : matches),
        ),
    },
    tournamentParticipant: {
      findMany: jest.fn().mockResolvedValue(participants),
    },
    tournament: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: T, config: {}, format: { config: {} } }),
    },
  } as any;
}

function participant(
  userId: string,
  points: number,
  wins: number,
  losses: number,
) {
  return {
    userId,
    user: { username: userId, displayName: null, avatarUrl: null },
    stats: {
      points,
      wins,
      losses,
      draws: 0,
      winRate: wins / Math.max(1, wins + losses),
    },
    tournament: { id: T, config: {}, format: { config: {} } },
  };
}

describe('GW% / OGW%', () => {
  it('counts games from the match scores, not matches', async () => {
    // One match, 2–1 in games. Match win rate is 100% / 0%; GAME win rate is
    // 66.7% / 33.3%. Reading the wrong column makes these identical.
    const service = new LeaderboardService(
      prismaWith(
        [
          {
            player1Id: 'a',
            player2Id: 'b',
            winnerId: 'a',
            player1Score: 2,
            player2Score: 1,
          },
        ],
        [participant('a', 3, 1, 0), participant('b', 0, 0, 1)],
      ),
    );

    const board = await service.getLeaderboard(T);
    const a = board.find((e) => e.userId === 'a')!;
    const b = board.find((e) => e.userId === 'b')!;

    expect(a.gw).toBeCloseTo(2 / 3, 4);
    expect(b.gw).toBeCloseTo(1 / 3, 4);
    // The match-level figure is untouched by any of this.
    expect(a.matchWinPct).toBe(1);
  });

  it('reports your own GW% unfloored, and floors it only as opponent strength', async () => {
    // b won no games at all. Their own GW% is 0; but as A's opponent they are
    // worth the 33% floor, exactly as OMW treats a winless opponent.
    const service = new LeaderboardService(
      prismaWith(
        [
          {
            player1Id: 'a',
            player2Id: 'b',
            winnerId: 'a',
            player1Score: 2,
            player2Score: 0,
          },
        ],
        [participant('a', 3, 1, 0), participant('b', 0, 0, 1)],
      ),
    );

    const board = await service.getLeaderboard(T);
    const a = board.find((e) => e.userId === 'a')!;
    const b = board.find((e) => e.userId === 'b')!;

    expect(b.gw).toBe(0);
    expect(a.gw).toBe(1);
    expect(a.ogw).toBeCloseTo(1 / 3, 4);
  });

  it('keeps byes out of opponent strength but counts them in your own record', async () => {
    // A bye has no opponent, so it must not touch anybody's OMW or OGW — but
    // excluding it entirely gave the player zero counted games and a GW% of 0,
    // ranking them last for having been given a free win (seen on trinity:
    // Rafael Costa, 3 points, gw=0.000).
    const service = new LeaderboardService(
      prismaWith(
        [
          {
            player1Id: 'a',
            player2Id: 'b',
            winnerId: 'a',
            player1Score: 2,
            player2Score: 1,
          },
        ],
        [
          participant('a', 3, 1, 0),
          participant('b', 0, 0, 1),
          participant('c', 3, 1, 0),
        ],
        [{ winnerId: 'c', player1Score: 1, player2Score: 0 }],
      ),
    );

    const board = await service.getLeaderboard(T);
    const c = board.find((e) => e.userId === 'c')!;

    // Credited, not punished.
    expect(c.gw).toBe(1);
    // And the bye gave c no opponents, so it cannot lend anyone strength.
    expect(c.omw).toBe(0);
    expect(c.ogw).toBe(0);
  });

  it('sorts by GW% when the configured order asks for it', async () => {
    // Level on points and on OMW (both opponents winless, both floored), so
    // only GW% can separate them. Without the sorter knowing `gw`, the order
    // would fall through to whatever came next.
    const service = new LeaderboardService(
      prismaWith(
        [
          {
            player1Id: 'a',
            player2Id: 'x',
            winnerId: 'a',
            player1Score: 2,
            player2Score: 0,
          },
          {
            player1Id: 'b',
            player2Id: 'y',
            winnerId: 'b',
            player1Score: 2,
            player2Score: 1,
          },
        ],
        [
          participant('b', 3, 1, 0),
          participant('a', 3, 1, 0),
          participant('x', 0, 0, 1),
          participant('y', 0, 0, 1),
        ],
      ),
    );

    const board = await service.getLeaderboard(T);
    const a = board.find((e) => e.userId === 'a')!;
    const b = board.find((e) => e.userId === 'b')!;

    // a dropped no games; b dropped one.
    expect(a.gw).toBe(1);
    expect(b.gw).toBeCloseTo(2 / 3, 4);
    expect(a.rank).toBeLessThan(b.rank);
  });

  it('ranks ties densely, as the global board does', async () => {
    // Two players level on everything, then a third behind them: 1, 1, 2 —
    // not 1, 1, 3. The per-tournament table used competition ranking while the
    // global board used dense, so the same app answered "what rank am I"
    // two different ways.
    const service = new LeaderboardService(
      prismaWith(
        [
          {
            player1Id: 'a',
            player2Id: 'b',
            winnerId: null,
            player1Score: 1,
            player2Score: 1,
          },
        ],
        [
          participant('a', 3, 1, 0),
          participant('b', 3, 1, 0),
          participant('c', 0, 0, 1),
        ],
      ),
    );

    const board = await service.getLeaderboard(T);
    expect(board.map((e) => e.rank)).toEqual([1, 1, 2]);
  });

  it('names the deciding tiebreaker as gw when that is what separated them', () => {
    const service = new LeaderboardService(prismaWith([], []));
    const base = {
      userId: 'a',
      username: 'a',
      points: 3,
      wins: 1,
      losses: 0,
      draws: 0,
      matchWinPct: 1,
      omw: 0.5,
      oomw: 0.5,
      gw: 1,
      ogw: 0.5,
    };

    const decided = service.tiebreakCriterion(base, { ...base, gw: 0.6 }, [
      'omw',
      'gw',
      'oomw',
    ]);
    expect(decided).toBe('gw');
  });
});
