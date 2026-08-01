import { TournamentService } from '../src/tournament/tournament.service';

// completeTournament increments lifetime counters (tournamentsPlayed,
// tournamentsWon, globalPoints) that have no recompute path, so calling it twice
// permanently inflates the global leaderboard. This is reachable in normal use:
// an organizer can finalize a tournament that still has pending matches, and
// completing one of those later re-triggers checkTournamentComplete.
describe('completeTournament idempotency', () => {
  let notificationsSpy: { notify: jest.Mock; notifyMany: jest.Mock };
  let realtimeSpy: { emitTournamentUpdated: jest.Mock };

  const buildService = (status: string) => {
    const prisma = {
      tournament: {
        findUnique: jest.fn().mockResolvedValue({
          id: 't1',
          name: 'Summer Cup',
          status,
          winnerId: 'w1',
          createdById: 'creator',
          participants: [],
          rounds: [],
        }),
        update: jest.fn().mockResolvedValue({ id: 't1', name: 'Summer Cup' }),
      },
      tournamentParticipant: { findMany: jest.fn().mockResolvedValue([]) },
      user: { updateMany: jest.fn() },
      userGlobalStats: { upsert: jest.fn() },
      userGameStats: { upsert: jest.fn() },
      match: { update: jest.fn() },
    } as any;
    // The award writes now run inside a transaction. The mock runs the callback
    // against itself, so these assertions still observe the same calls.
    prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));

    const leaderboard = {
      getLeaderboard: jest.fn().mockResolvedValue([]),
    } as any;
    realtimeSpy = { emitTournamentUpdated: jest.fn() };
    notificationsSpy = { notify: jest.fn(), notifyMany: jest.fn() };
    const realtime = realtimeSpy as any;
    const notifications = notificationsSpy as any;

    return {
      prisma,
      service: new TournamentService(
        prisma,
        {} as any,
        leaderboard,
        realtime,
        notifications,
      ),
    };
  };

  it('awards nothing when the tournament is already COMPLETED', async () => {
    const { prisma, service } = buildService('COMPLETED');

    const result = await service.completeTournament('t1');

    expect(prisma.userGlobalStats.upsert).not.toHaveBeenCalled();
    expect(prisma.userGameStats.upsert).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        message: expect.stringMatching(/already completed/i),
      }),
    );
  });

  it('sends nothing when the transaction rolls back', async () => {
    // The point of collecting notifications instead of sending them inline: a
    // socket message or an inbox row cannot be recalled if the writes are undone.
    const { prisma, service } = buildService('ONGOING');
    prisma.$transaction = jest.fn().mockRejectedValue(new Error('db failure'));

    await expect(service.completeTournament('t1')).rejects.toThrow(
      'db failure',
    );

    expect(notificationsSpy.notify).not.toHaveBeenCalled();
    expect(realtimeSpy.emitTournamentUpdated).not.toHaveBeenCalled();
  });

  it('proceeds normally for an ONGOING tournament', async () => {
    const { prisma, service } = buildService('ONGOING');

    await service.completeTournament('t1');

    // It got past the guard and reached the completion work.
    expect(prisma.tournament.update).toHaveBeenCalled();
  });
});
