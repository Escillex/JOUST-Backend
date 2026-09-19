import { MatchService } from '../src/tournament/match/match.service';
import * as stats from '../src/tournament/match/match-stats.helper';

describe('bracket result reset and re-report', () => {
  const setup = () => {
    const tournament = {
      id: 't',
      system: 'SINGLE_ELIMINATION',
      status: 'ONGOING',
      config: {},
      format: null,
    };
    const makeMatch = (id: string, over: Record<string, unknown>) => ({
      id,
      status: 'COMPLETED',
      player1Id: 'a',
      player2Id: 'b',
      winnerId: 'a',
      player1Score: 1,
      player2Score: 0,
      reportedWinnerId: null,
      isBye: false,
      nextMatchId: null,
      loserNextMatchId: null,
      phase: null,
      startedAt: null,
      gameLogs: [],
      round: { tournamentId: 't', roundNumber: 1, tournament },
      ...over,
    });
    const rows: Record<string, any> = {
      semi1: makeMatch('semi1', { nextMatchId: 'final' }),
      semi2: makeMatch('semi2', {
        player1Id: 'c',
        player2Id: 'd',
        winnerId: 'c',
        nextMatchId: 'final',
      }),
      final: makeMatch('final', {
        status: 'PENDING',
        player1Id: 'a',
        player2Id: 'c',
        winnerId: null,
        player1Score: 0,
      }),
    };
    const prisma: any = {
      match: {
        findUnique: jest.fn(async ({ where }) =>
          rows[where.id] ? { ...rows[where.id] } : null,
        ),
        findMany: jest.fn(async ({ where }) =>
          Object.values(rows).filter((row) =>
            where.id
              ? where.id.in.includes(row.id)
              : where.OR.some((condition: any) =>
                  Object.entries(condition).every(
                    ([key, value]) => row[key] === value,
                  ),
                ),
          ),
        ),
        update: jest.fn(async ({ where, data }) => {
          Object.assign(rows[where.id], data);
          return { ...rows[where.id] };
        }),
      },
      matchGameLog: { update: jest.fn() },
      round: { findFirst: jest.fn().mockResolvedValue(null) },
      tournament: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
      tournamentParticipant: { findMany: jest.fn().mockResolvedValue([]) },
    };
    prisma.$transaction = jest.fn(async (callback) => {
      const snapshot = structuredClone(rows);
      try {
        return await callback(prisma);
      } catch (error) {
        Object.assign(rows, snapshot);
        throw error;
      }
    });
    const notifications: any = { notifyMany: jest.fn(), notify: jest.fn() };
    const realtime: any = { emitTournamentUpdated: jest.fn() };
    const formats: any = {
      handleMatchCompletion: jest.fn(async (id: string) => {
        const match = rows[id];
        if (match.nextMatchId)
          await service.advanceWinner(match.winnerId, match.nextMatchId);
      }),
    };
    const service = new MatchService(prisma, formats, notifications, realtime);
    return { service, rows, prisma, tournament, realtime };
  };

  it('retracts a winner and preserves the other semifinal winner through repeated edits', async () => {
    const { service, rows } = setup();
    for (const winner of ['b', 'a', 'b']) {
      await service.resetMatch('semi1');
      expect([rows.final.player1Id, rows.final.player2Id]).toEqual(['c', null]);
      await service.submitResult('semi1', winner);
      expect([rows.final.player1Id, rows.final.player2Id]).toEqual([
        'c',
        winner,
      ]);
    }
  });

  it('repairs a pending final whose slots were duplicated by an earlier reset', async () => {
    const { service, rows } = setup();
    rows.final.player1Id = 'c';
    rows.final.player2Id = 'c';
    await service.resetMatch('semi2');
    await service.submitResult('semi2', 'c');
    expect([rows.final.player1Id, rows.final.player2Id]).toEqual(['a', 'c']);
  });

  it('also retracts the loser from a double-elimination destination', async () => {
    const { service, rows, tournament } = setup();
    tournament.system = 'DOUBLE_ELIMINATION';
    rows.semi1.loserNextMatchId = 'lower';
    rows.lower = {
      ...rows.final,
      id: 'lower',
      player1Id: 'b',
      player2Id: null,
    };
    await service.resetMatch('semi1');
    expect([rows.lower.player1Id, rows.lower.player2Id]).toEqual([null, null]);
    expect([rows.final.player1Id, rows.final.player2Id]).toEqual(['c', null]);
  });

  it.each(['ONGOING', 'COMPLETED'])(
    'refuses before any changes when a dependent match is %s',
    async (status) => {
      const { service, rows, prisma, realtime } = setup();
      rows.final.status = status;
      await expect(service.resetMatch('semi1')).rejects.toThrow(
        'dependent match has already started',
      );
      expect(prisma.match.update).not.toHaveBeenCalled();
      expect(realtime.emitTournamentUpdated).not.toHaveBeenCalled();
      expect(rows.semi1.winnerId).toBe('a');
    },
  );

  it('rolls back the entire reset if updating a downstream pairing fails', async () => {
    const { service, rows, prisma } = setup();
    const update = prisma.match.update.getMockImplementation();
    prisma.match.update.mockImplementation(async (args: any) => {
      if (args.where.id === 'final') throw new Error('write failed');
      return update(args);
    });
    await expect(service.resetMatch('semi1')).rejects.toThrow('write failed');
    expect(rows.semi1.status).toBe('COMPLETED');
    expect(rows.semi1.winnerId).toBe('a');
  });

  it('reverses stats with negative direction and positive configured points', async () => {
    const spy = jest.spyOn(stats, 'applyMatchStats');
    try {
      const { service, prisma } = setup();
      await service.resetMatch('semi1');
      expect(spy).toHaveBeenCalledWith(
        prisma,
        'semi1',
        expect.objectContaining({ pointsForWin: expect.any(Number) }),
        'WIN',
        -1,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it.each(['advanceWinner', 'advanceLoser'] as const)(
    '%s is idempotent and never overwrites a full match',
    async (method) => {
      const { service, rows, prisma } = setup();
      await service[method]('a', 'final');
      expect(prisma.match.update).not.toHaveBeenCalled();
      await expect(service[method]('b', 'final')).rejects.toThrow('full match');
      expect([rows.final.player1Id, rows.final.player2Id]).toEqual(['a', 'c']);
    },
  );

  it.each(['SWISS', 'HYBRID', 'DOUBLE_ELIMINATION'])(
    'protects generated dependent rounds in %s',
    async (system) => {
      const { service, rows, tournament, prisma } = setup();
      tournament.system = system;
      rows.semi1.phase = 1;
      if (system === 'DOUBLE_ELIMINATION') rows.semi1.round.roundNumber = 200;
      prisma.round.findFirst.mockResolvedValue({ id: 'later' });
      await expect(service.resetMatch('semi1')).rejects.toThrow(
        'dependent round has been generated',
      );
      expect(prisma.match.update).not.toHaveBeenCalled();
    },
  );
});
