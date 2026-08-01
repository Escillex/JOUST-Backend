import { LeaderboardService } from './leaderboard.service';
import { MatchStatus } from '@prisma/client';

/**
 * Plan 8.2. These assert the placings the plan specifies: champion = final/GF
 * winner, 2nd = final/GF loser, 3rd = losing semifinalist (both of them), and
 * the rest ordered by how deep they ran.
 */
describe('computeStructuralPlacements', () => {
  const m = (
    roundNumber: number,
    player1Id: string,
    player2Id: string,
    winnerId: string,
    nextMatchId: string | null = 'next',
  ) => ({
    player1Id,
    player2Id,
    winnerId,
    nextMatchId,
    status: MatchStatus.COMPLETED,
    isBye: false,
    round: { roundNumber },
  });

  const serviceWith = (matches: unknown[]) =>
    new LeaderboardService({
      match: { findMany: jest.fn().mockResolvedValue(matches) },
    } as never);

  it('ranks a 4-player single elimination by how far each player got', async () => {
    // R1: A>B, C>D   R2 (final): A>C
    const svc = serviceWith([
      m(1, 'A', 'B', 'A'),
      m(1, 'C', 'D', 'C'),
      m(2, 'A', 'C', 'A', null),
    ]);
    const p = await svc.computeStructuralPlacements('t1');
    expect(p.get('A')).toBe(1); // won the final
    expect(p.get('C')).toBe(2); // lost the final
    // Both first-round losers went out at the same depth, so they share 3rd.
    expect(p.get('B')).toBe(3);
    expect(p.get('D')).toBe(3);
  });

  it('gives both losing semifinalists the same rank in an 8-player bracket', async () => {
    const svc = serviceWith([
      m(1, 'A', 'H', 'A'),
      m(1, 'D', 'E', 'D'),
      m(1, 'B', 'G', 'B'),
      m(1, 'C', 'F', 'C'),
      m(2, 'A', 'D', 'A'),
      m(2, 'B', 'C', 'B'),
      m(3, 'A', 'B', 'A', null),
    ]);
    const p = await svc.computeStructuralPlacements('t1');
    expect(p.get('A')).toBe(1);
    expect(p.get('B')).toBe(2);
    expect(p.get('D')).toBe(3);
    expect(p.get('C')).toBe(3);
    // The four round-1 exits share the next rank after two players on 3rd.
    expect(p.get('H')).toBe(5);
  });

  it('uses the LAST loss in double elimination, so a winners-bracket loss is not an exit', async () => {
    // X loses the winners final (round 2) but wins the losers final (104) and
    // then the grand final (200): X must be champion, not an early exit.
    const svc = serviceWith([
      m(1, 'X', 'P', 'X'),
      m(2, 'Y', 'X', 'Y'), // X's FIRST loss — drops to losers, not eliminated
      m(104, 'X', 'Q', 'X'), // losers final
      m(200, 'X', 'Y', 'X', null), // grand final
    ]);
    const p = await svc.computeStructuralPlacements('t1');
    expect(p.get('X')).toBe(1);
    expect(p.get('Y')).toBe(2); // lost the grand final
    expect(p.get('Q')).toBe(3); // lost the losers final
    expect(p.get('P')).toBe(4);
  });

  it('ignores draws, which eliminate nobody', async () => {
    const svc = serviceWith([
      { ...m(1, 'A', 'B', 'A'), winnerId: null },
      m(2, 'A', 'B', 'A', null),
    ]);
    const p = await svc.computeStructuralPlacements('t1');
    expect(p.get('A')).toBe(1);
    expect(p.get('B')).toBe(2);
  });

  it('returns an empty map when nothing has been played', async () => {
    const svc = serviceWith([]);
    expect((await svc.computeStructuralPlacements('t1')).size).toBe(0);
  });

  it('restricts to one phase when asked, for a hybrid top cut', async () => {
    const findMany = jest.fn().mockResolvedValue([m(1, 'A', 'B', 'A', null)]);
    const svc = new LeaderboardService({ match: { findMany } } as never);
    await svc.computeStructuralPlacements('t1', 2);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ phase: 2 }),
      }),
    );
  });
});
