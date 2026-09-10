import { BadRequestException } from '@nestjs/common';
import { TournamentService } from '../src/tournament/tournament.service';

// startTournament generates a bracket through many separate writes with no
// transaction around them. Rather than wrap the engine (which would nest a
// transaction inside completeTournament via the bye cascade), the method claims
// the start atomically, verifies the result, and rolls back on failure.
describe('startTournament', () => {
  const PLAYERS = ['p1', 'p2', 'p3', 'p4'];

  const buildService = (opts: {
    status?: string;
    claimCount?: number;
    existingRound?: { matches: any[] } | null;
    generatedRound?: { matches: any[] } | null;
    generateThrows?: boolean;
  }) => {
    const generated = opts.generatedRound;

    const prisma = {
      tournament: {
        findUnique: jest
          .fn()
          // First call: the tournament being started.
          .mockResolvedValueOnce({
            id: 't1',
            status: opts.status ?? 'OPEN',
            format: { id: 'f1', system: 'SINGLE_ELIMINATION' },
            participants: PLAYERS.map((id) => ({
              id: `part-${id}`,
              userId: id,
              stats: {},
            })),
            rounds: opts.existingRound ? [opts.existingRound] : [],
          })
          // Second call: re-read after generation.
          .mockResolvedValue({ rounds: generated ? [generated] : [] }),
        updateMany: jest
          .fn()
          .mockResolvedValue({ count: opts.claimCount ?? 1 }),
        update: jest.fn().mockResolvedValue({ id: 't1', name: 'Cup' }),
      },
      tournamentParticipant: { findMany: jest.fn().mockResolvedValue([]) },
      tournamentParticipantStats: { create: jest.fn() },
      match: {
        update: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
      },
      round: { deleteMany: jest.fn() },
    } as any;
    prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));

    const formats = {
      initializeTournamentFormat: opts.generateThrows
        ? jest.fn().mockRejectedValue(new Error('generation blew up'))
        : jest.fn().mockResolvedValue(undefined),
      handleMatchCompletion: jest.fn(),
    } as any;

    const service = new TournamentService(
      prisma,
      formats,
      { getLeaderboard: jest.fn().mockResolvedValue([]) } as any,
      { emitTournamentUpdated: jest.fn() } as any,
      { notify: jest.fn(), notifyMany: jest.fn() } as any,
      { assertAssignable: jest.fn() } as any,
    );
    return { prisma, formats, service };
  };

  const completeRound = () => ({
    matches: [
      { id: 'm1', player1Id: 'p1', player2Id: 'p2', isBye: false },
      { id: 'm2', player1Id: 'p3', player2Id: 'p4', isBye: false },
    ],
  });

  const partialRound = () => ({
    // Only half the players placed: generation died partway.
    matches: [{ id: 'm1', player1Id: 'p1', player2Id: 'p2', isBye: false }],
  });

  it('claims the start atomically and generates once', async () => {
    const { prisma, formats, service } = buildService({
      generatedRound: completeRound(),
    });

    await service.startTournament('t1');

    expect(prisma.tournament.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 't1', status: 'OPEN' }),
      }),
    );
    expect(formats.initializeTournamentFormat).toHaveBeenCalledTimes(1);
  });

  it('refuses when another request already claimed the start', async () => {
    // The second of two near-simultaneous taps on a flaky connection: the
    // conditional update matches no rows, so this request must not generate.
    const { formats, service } = buildService({
      claimCount: 0,
      generatedRound: completeRound(),
    });

    await expect(service.startTournament('t1')).rejects.toThrow(
      BadRequestException,
    );
    expect(formats.initializeTournamentFormat).not.toHaveBeenCalled();
  });

  it('rejects a bracket that generated incompletely', async () => {
    const { service } = buildService({ generatedRound: partialRound() });

    await expect(service.startTournament('t1')).rejects.toThrow(
      /did not complete/i,
    );
  });

  it('restores the tournament to OPEN when generation fails', async () => {
    // Without this the atomic claim would strand it in ONGOING with a broken
    // bracket, and ONGOING only leads to COMPLETED.
    const { prisma, service } = buildService({ generateThrows: true });

    await expect(service.startTournament('t1')).rejects.toThrow();

    expect(prisma.tournament.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'OPEN' } }),
    );
    expect(prisma.round.deleteMany).toHaveBeenCalled();
    expect(prisma.match.deleteMany).toHaveBeenCalled();
  });

  it('discards a partial round left by a previous attempt and rebuilds', async () => {
    const { prisma, formats, service } = buildService({
      existingRound: partialRound(),
      generatedRound: completeRound(),
    });

    await service.startTournament('t1');

    expect(prisma.round.deleteMany).toHaveBeenCalled();
    expect(formats.initializeTournamentFormat).toHaveBeenCalledTimes(1);
  });

  it('reuses a complete round from a previous attempt without regenerating', async () => {
    const { formats, service } = buildService({
      existingRound: completeRound(),
    });

    await service.startTournament('t1');

    expect(formats.initializeTournamentFormat).not.toHaveBeenCalled();
  });
});
