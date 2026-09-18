import { TournamentService } from '../src/tournament/tournament.service';

/**
 * Deleting a tournament (2026-09-16). There was no route at all: a tournament
 * created by mistake stayed forever, and test data could only be removed with
 * SQL. A finished one is still refused — its results are in players' profiles
 * and its points are already in their lifetime totals.
 */
const svcWith = (tournament: any, matches = 0) => {
  const tx = {
    match: { deleteMany: jest.fn(async () => ({ count: matches })) },
    round: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    tournamentParticipant: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    tournament: { delete: jest.fn(async () => ({})) },
  };
  const prisma: any = {
    tournament: { findUnique: jest.fn(async () => tournament) },
    match: { count: jest.fn(async () => matches) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const service = new TournamentService(
    prisma,
    ...(Array(6).fill({}) as [any, any, any, any, any, any]),
  );
  return { service, prisma, tx };
};

const row = (status: string) => ({
  id: 't1',
  name: 'Friday Night',
  status,
  _count: { participants: 4, rounds: 2 },
});
const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: any) => e.getResponse?.().code ?? e.message,
  );

describe('deleting a tournament', () => {
  it.each(['UPCOMING', 'OPEN', 'ONGOING'])(
    'is allowed while %s — nothing is awarded until it finishes',
    async (status) => {
      const { service, tx } = svcWith(row(status), 6);
      await expect(service.deleteTournament('t1')).resolves.toMatchObject({
        participants: 4,
        matches: 6,
      });
      // Children first, in an order Postgres will accept.
      expect(tx.match.deleteMany).toHaveBeenCalledWith({
        where: { round: { tournamentId: 't1' } },
      });
      expect(tx.round.deleteMany).toHaveBeenCalledWith({
        where: { tournamentId: 't1' },
      });
      expect(tx.tournamentParticipant.deleteMany).toHaveBeenCalledWith({
        where: { tournamentId: 't1' },
      });
      expect(tx.tournament.delete).toHaveBeenCalledWith({
        where: { id: 't1' },
      });
      const order = [
        tx.match.deleteMany.mock.invocationCallOrder[0],
        tx.round.deleteMany.mock.invocationCallOrder[0],
        tx.tournamentParticipant.deleteMany.mock.invocationCallOrder[0],
        tx.tournament.delete.mock.invocationCallOrder[0],
      ];
      expect(order).toEqual([...order].sort((a, b) => a - b));
    },
  );

  it('is refused once it has finished, and says why', async () => {
    const { service, tx } = svcWith(row('COMPLETED'));
    expect(await codeOf(service.deleteTournament('t1'))).toBe(
      'TOURNAMENT_COMPLETED',
    );
    expect(tx.tournament.delete).not.toHaveBeenCalled();
  });

  it('says so when there is nothing to delete', async () => {
    const { service } = svcWith(null);
    await expect(service.deleteTournament('t1')).rejects.toThrow(
      'Tournament not found',
    );
  });

  it('deletes everything in one transaction, so a failure leaves the tournament whole', async () => {
    const { service, prisma } = svcWith(row('ONGOING'), 3);
    await service.deleteTournament('t1');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
