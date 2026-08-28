import { MatchService } from '../src/tournament/match/match.service';
import { FormatsService } from '../src/Formats/formats.service';
import { ParticipantService } from '../src/tournament/participant/participant.service';
import { RealtimeGateway } from '../src/realtime/realtime.gateway';
import { TournamentService } from '../src/tournament/tournament.service';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service';
import { MatchStatus } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';

// Focused unit-style test for MatchService.completeAsWalkover, following the
// mocked-Prisma pattern used elsewhere in this suite (see
// status-transition.e2e-spec.ts) rather than spinning up a full Nest app,
// since this method has no controller route of its own yet.
describe('MatchService.completeAsWalkover', () => {
  let matchService: MatchService;
  let prisma: any;
  let formatsService: { handleMatchCompletion: jest.Mock };

  beforeEach(() => {
    prisma = {
      match: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      tournamentParticipant: {
        findUnique: jest.fn(),
      },
      tournamentParticipantStats: {
        create: jest.fn(),
        update: jest.fn(),
      },
      // Fix round 1: creditWalkoverWin now also credits the winner's
      // lifetime/game stats (see updateMatchStats' maybeUpdateGlobalStats),
      // so the mock Prisma surface needs these three models too.
      userGlobalStats: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
      },
      tournament: {
        findUnique: jest.fn().mockResolvedValue({ format: null }),
      },
      userGameStats: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    // Transaction-aware code under test calls prisma.$transaction(cb). The
    // mock runs the callback against itself, so the assertions below are
    // unchanged by the wrapping.
    prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));

    formatsService = {
      handleMatchCompletion: jest.fn().mockResolvedValue(undefined),
    };

    matchService = new MatchService(
      prisma,
      formatsService as unknown as FormatsService,
      // Notifications are best-effort side effects, stubbed so this suite stays
      // focused on the behaviour it is actually asserting.
      { notify: jest.fn(), notifyMany: jest.fn() } as any,
    );
  });

  it('completeAsWalkover awards the opponent and propagates', async () => {
    // match m1: player1 = forfeiter, player2 = opponent, status ONGOING
    prisma.match.findUnique.mockResolvedValue({
      id: 'm1',
      status: MatchStatus.ONGOING,
      player1Id: 'forfeiter',
      player2Id: 'opponent',
      round: { tournamentId: 't1' },
    });

    prisma.tournamentParticipant.findUnique.mockResolvedValue({
      id: 'participant-opponent',
      stats: {
        id: 'stats-opponent',
        gamesPlayed: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        winRate: 0,
      },
      user: { isGuest: false },
    });

    prisma.match.update.mockResolvedValue({
      id: 'm1',
      winnerId: 'opponent',
      status: MatchStatus.COMPLETED,
    });

    prisma.tournamentParticipantStats.update.mockResolvedValue({});

    await matchService.completeAsWalkover('m1', 'opponent');

    expect(prisma.match.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'm1' },
        data: expect.objectContaining({
          winnerId: 'opponent',
          status: 'COMPLETED',
        }),
      }),
    );
    expect(formatsService.handleMatchCompletion).toHaveBeenCalledWith('m1');
  });

  it('credits only the winner — the forfeiter gains no games/wins', async () => {
    prisma.match.findUnique.mockResolvedValue({
      id: 'm1',
      status: MatchStatus.ONGOING,
      player1Id: 'forfeiter',
      player2Id: 'opponent',
      round: { tournamentId: 't1' },
    });

    prisma.tournamentParticipant.findUnique.mockResolvedValue({
      id: 'participant-opponent',
      stats: {
        id: 'stats-opponent',
        gamesPlayed: 3,
        wins: 2,
        losses: 1,
        draws: 0,
        winRate: 2 / 3,
      },
      user: { isGuest: false },
    });

    prisma.match.update.mockResolvedValue({
      id: 'm1',
      winnerId: 'opponent',
      status: MatchStatus.COMPLETED,
    });

    prisma.tournamentParticipantStats.update.mockResolvedValue({});

    await matchService.completeAsWalkover('m1', 'opponent');

    // Only the winner's participant row is looked up — the forfeiter's stats
    // are never touched.
    expect(prisma.tournamentParticipant.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.tournamentParticipant.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_tournamentId: { userId: 'opponent', tournamentId: 't1' },
        },
      }),
    );

    expect(prisma.tournamentParticipantStats.update).toHaveBeenCalledWith({
      where: { id: 'stats-opponent' },
      data: {
        gamesPlayed: 4,
        wins: 3,
        winRate: 3 / 4,
      },
    });
  });

  it('is a no-op when the match is already completed', async () => {
    prisma.match.findUnique.mockResolvedValue({
      id: 'm1',
      status: MatchStatus.COMPLETED,
      player1Id: 'forfeiter',
      player2Id: 'opponent',
      round: { tournamentId: 't1' },
    });

    await matchService.completeAsWalkover('m1', 'opponent');

    expect(prisma.match.update).not.toHaveBeenCalled();
    expect(formatsService.handleMatchCompletion).not.toHaveBeenCalled();
  });

  // Fix round 1 — coordinator-flagged spec gap: a walkover must be a truly
  // normal win for the winner, which means it has to reach their lifetime
  // (UserGlobalStats) and per-game (UserGameStats) stats too, exactly like a
  // normal result does via updateMatchStats' maybeUpdateGlobalStats closure.
  it('credits the winner (non-guest) UserGlobalStats and UserGameStats, never the loser', async () => {
    prisma.match.findUnique.mockResolvedValue({
      id: 'm1',
      status: MatchStatus.ONGOING,
      player1Id: 'forfeiter',
      player2Id: 'opponent',
      round: { tournamentId: 't1' },
    });

    prisma.tournamentParticipant.findUnique.mockResolvedValue({
      id: 'participant-opponent',
      stats: {
        id: 'stats-opponent',
        gamesPlayed: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        winRate: 0,
      },
      user: { isGuest: false },
    });

    prisma.match.update.mockResolvedValue({
      id: 'm1',
      winnerId: 'opponent',
      status: MatchStatus.COMPLETED,
    });

    prisma.tournamentParticipantStats.update.mockResolvedValue({});

    // Winner already has 5 games / 3 wins lifetime, and the tournament's
    // format has a gameName so per-game stats are also in play.
    prisma.userGlobalStats.findUnique.mockResolvedValue({
      userId: 'opponent',
      tournamentsPlayed: 1,
      tournamentsWon: 0,
      gamesPlayed: 5,
      wins: 3,
      losses: 2,
      draws: 0,
      winRate: 3 / 5,
    });
    prisma.tournament.findUnique.mockResolvedValue({
      format: { gameName: 'Chess' },
    });
    prisma.userGameStats.findUnique.mockResolvedValue({
      userId: 'opponent',
      gameName: 'Chess',
      gamesPlayed: 2,
      wins: 1,
      losses: 1,
      draws: 0,
      winRate: 0.5,
    });

    await matchService.completeAsWalkover('m1', 'opponent');

    // Winner's lifetime stats go up by exactly one win/one game.
    expect(prisma.userGlobalStats.update).toHaveBeenCalledWith({
      where: { userId: 'opponent' },
      data: {
        gamesPlayed: 6,
        wins: 4,
        losses: 2,
        draws: 0,
        winRate: 4 / 6,
      },
    });
    expect(prisma.userGlobalStats.create).not.toHaveBeenCalled();

    // Winner's per-game stats go up the same way.
    expect(prisma.userGameStats.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_gameName: { userId: 'opponent', gameName: 'Chess' } },
        update: expect.objectContaining({
          gamesPlayed: 3,
          wins: 2,
          winRate: 2 / 3,
        }),
      }),
    );

    // The loser/forfeiter is never looked up or written to, anywhere.
    expect(prisma.userGlobalStats.findUnique).not.toHaveBeenCalledWith({
      where: { userId: 'forfeiter' },
    });
    expect(prisma.userGlobalStats.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'forfeiter' } }),
    );
    expect(prisma.userGameStats.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId_gameName: expect.objectContaining({ userId: 'forfeiter' }),
        }),
      }),
    );
  });

  it('skips UserGlobalStats/UserGameStats for a guest winner', async () => {
    prisma.match.findUnique.mockResolvedValue({
      id: 'm1',
      status: MatchStatus.ONGOING,
      player1Id: 'forfeiter',
      player2Id: 'guest-opponent',
      round: { tournamentId: 't1' },
    });

    prisma.tournamentParticipant.findUnique.mockResolvedValue({
      id: 'participant-guest-opponent',
      stats: {
        id: 'stats-guest-opponent',
        gamesPlayed: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        winRate: 0,
      },
      user: { isGuest: true },
    });

    prisma.match.update.mockResolvedValue({
      id: 'm1',
      winnerId: 'guest-opponent',
      status: MatchStatus.COMPLETED,
    });

    prisma.tournamentParticipantStats.update.mockResolvedValue({});

    await matchService.completeAsWalkover('m1', 'guest-opponent');

    expect(prisma.tournamentParticipantStats.update).toHaveBeenCalled();
    expect(prisma.userGlobalStats.findUnique).not.toHaveBeenCalled();
    expect(prisma.userGlobalStats.update).not.toHaveBeenCalled();
    expect(prisma.userGlobalStats.create).not.toHaveBeenCalled();
    expect(prisma.userGameStats.upsert).not.toHaveBeenCalled();
  });
});

// Covers MatchService.resolveForfeitedPairing and its hook into advanceLoser /
// advanceWinner: filling a slot opposite a FORFEITED participant must
// auto-resolve the match via completeAsWalkover instead of activating it —
// this is what lets a forfeit terminate cleanly through a double-elimination
// losers-bracket drop rather than stalling on an unplayable pairing.
describe('MatchService.resolveForfeitedPairing (via advanceWinner/advanceLoser)', () => {
  let matchService: MatchService;
  let prisma: any;
  let formatsService: { handleMatchCompletion: jest.Mock };

  beforeEach(() => {
    prisma = {
      match: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      tournamentParticipant: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      tournamentParticipantStats: {
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      userGlobalStats: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
      },
      tournament: {
        findUnique: jest.fn().mockResolvedValue({ format: null }),
      },
      userGameStats: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    // Transaction-aware code under test calls prisma.$transaction(cb). The
    // mock runs the callback against itself, so the assertions below are
    // unchanged by the wrapping.
    prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));

    formatsService = {
      handleMatchCompletion: jest.fn().mockResolvedValue(undefined),
    };

    matchService = new MatchService(
      prisma,
      formatsService as unknown as FormatsService,
      // Notifications are best-effort side effects, stubbed so this suite stays
      // focused on the behaviour it is actually asserting.
      { notify: jest.fn(), notifyMany: jest.fn() } as any,
    );
  });

  it('advanceLoser into a slot opposite a FORFEITED player auto-awards the active one', async () => {
    // losers match 'L' currently has player1 = 'x' (FORFEITED), player2 = null.
    const matchL: any = {
      id: 'L',
      status: MatchStatus.PENDING,
      player1Id: 'x',
      player2Id: null,
      isBye: false,
      round: { tournamentId: 't1' },
    };

    // Backing store mimics Prisma: findUnique reads current state, update
    // mutates it. resolveForfeitedPairing (and completeAsWalkover inside it)
    // re-reads the match after advanceLoser fills the slot, so a single
    // static mockResolvedValue would not reflect the fill.
    prisma.match.findUnique.mockImplementation(({ where }: any) => {
      if (where.id === 'L') return Promise.resolve({ ...matchL });
      return Promise.resolve(null);
    });
    prisma.match.update.mockImplementation(({ where, data }: any) => {
      if (where.id === 'L') {
        Object.assign(matchL, data);
        return Promise.resolve({ ...matchL });
      }
      return Promise.resolve(null);
    });

    prisma.tournamentParticipant.findMany.mockResolvedValue([
      { userId: 'x', status: 'FORFEITED' },
      { userId: 'p', status: 'ACTIVE' },
    ]);

    // completeAsWalkover -> creditWalkoverWin looks up the winner's
    // participant row; no participant found is a harmless no-op for stats
    // purposes — this test only asserts propagation.
    prisma.tournamentParticipant.findUnique.mockResolvedValue(null);

    await matchService.advanceLoser('p', 'L');

    // resolveForfeitedPairing should award 'p' via completeAsWalkover -> handleMatchCompletion('L')
    expect(formatsService.handleMatchCompletion).toHaveBeenCalledWith('L');
    expect(matchL.status).toBe(MatchStatus.COMPLETED);
    expect(matchL.winnerId).toBe('p');
  });

  it('advanceLoser into a slot with two ACTIVE players does not auto-resolve — stays PENDING for the organizer to start (F2)', async () => {
    const matchL2: any = {
      id: 'L2',
      status: MatchStatus.PENDING,
      player1Id: 'y',
      player2Id: null,
      isBye: false,
      round: { tournamentId: 't1' },
    };

    prisma.match.findUnique.mockImplementation(({ where }: any) => {
      if (where.id === 'L2') return Promise.resolve({ ...matchL2 });
      return Promise.resolve(null);
    });
    prisma.match.update.mockImplementation(({ where, data }: any) => {
      if (where.id === 'L2') {
        Object.assign(matchL2, data);
        return Promise.resolve({ ...matchL2 });
      }
      return Promise.resolve(null);
    });

    prisma.tournamentParticipant.findMany.mockResolvedValue([
      { userId: 'y', status: 'ACTIVE' },
      { userId: 'q', status: 'ACTIVE' },
    ]);

    await matchService.advanceLoser('q', 'L2');

    expect(formatsService.handleMatchCompletion).not.toHaveBeenCalled();
    // F2: nothing auto-activates — the filled match waits PENDING for startMatch.
    expect(matchL2.status).toBe(MatchStatus.PENDING);
  });

  // Global constraint: a pairing where BOTH players are FORFEITED must not
  // auto-resolve — there is no active player to award the walkover to, so it
  // falls through to normal activation (or stays as-is) rather than
  // completing the match.
  it('advanceLoser into a slot where both players are FORFEITED does not auto-resolve', async () => {
    const matchL3: any = {
      id: 'L3',
      status: MatchStatus.PENDING,
      player1Id: 'x',
      player2Id: null,
      isBye: false,
      round: { tournamentId: 't1' },
    };

    prisma.match.findUnique.mockImplementation(({ where }: any) => {
      if (where.id === 'L3') return Promise.resolve({ ...matchL3 });
      return Promise.resolve(null);
    });
    prisma.match.update.mockImplementation(({ where, data }: any) => {
      if (where.id === 'L3') {
        Object.assign(matchL3, data);
        return Promise.resolve({ ...matchL3 });
      }
      return Promise.resolve(null);
    });

    prisma.tournamentParticipant.findMany.mockResolvedValue([
      { userId: 'x', status: 'FORFEITED' },
      { userId: 'z', status: 'FORFEITED' },
    ]);

    await matchService.advanceLoser('z', 'L3');

    expect(formatsService.handleMatchCompletion).not.toHaveBeenCalled();
    expect(matchL3.status).not.toBe(MatchStatus.COMPLETED);
    // F2: stays PENDING (no auto-activation) rather than being force-activated.
    expect(matchL3.status).toBe(MatchStatus.PENDING);
  });
});

// Covers ParticipantService.forfeitParticipant: marking a player FORFEITED,
// awarding their pending matches (with a determined opponent) to the
// opponent via MatchService.completeAsWalkover, emitting a realtime refresh,
// and enforcing organizer/admin ownership. MatchService and RealtimeGateway
// are stubbed here since this is a focused unit test of ParticipantService
// alone (their own behavior is covered by the suites above / elsewhere).
describe('ParticipantService.forfeitParticipant', () => {
  let participantService: ParticipantService;
  let prisma: any;
  let matchService: { completeAsWalkover: jest.Mock };
  let realtime: { emitTournamentUpdated: jest.Mock };

  beforeEach(() => {
    prisma = {
      tournament: {
        findUnique: jest.fn(),
      },
      tournamentParticipant: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      match: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    // Transaction-aware code under test calls prisma.$transaction(cb). The
    // mock runs the callback against itself, so the assertions below are
    // unchanged by the wrapping.
    prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));

    matchService = {
      completeAsWalkover: jest.fn().mockResolvedValue(undefined),
    };

    realtime = {
      emitTournamentUpdated: jest.fn(),
    };

    participantService = new ParticipantService(
      prisma,
      matchService as unknown as MatchService,
      realtime as unknown as RealtimeGateway,
      // Notifications are best-effort side effects, stubbed so this suite stays
      // focused on the behaviour it is actually asserting.
      { notify: jest.fn(), notifyMany: jest.fn() } as any,
    );
  });

  it('forfeit awards the pending match to the opponent and emits update', async () => {
    prisma.tournament.findUnique.mockResolvedValue({
      id: 't1',
      status: 'ONGOING',
      createdById: 'owner',
    });
    prisma.tournamentParticipant.findUnique.mockResolvedValue({
      id: 'p1',
      userId: 'forfeiter',
      tournamentId: 't1',
      status: 'ACTIVE',
    });
    prisma.match.findMany.mockResolvedValue([
      {
        id: 'm1',
        status: 'ONGOING',
        player1Id: 'forfeiter',
        player2Id: 'opponent',
      },
    ]);

    await participantService.forfeitParticipant('t1', 'forfeiter', {
      id: 'owner',
      roles: ['ORGANIZER'],
    } as any);

    expect(prisma.tournamentParticipant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'FORFEITED' } }),
    );
    expect(matchService.completeAsWalkover).toHaveBeenCalledWith(
      'm1',
      'opponent',
    );
    expect(realtime.emitTournamentUpdated).toHaveBeenCalledWith('t1');
  });

  it('does not award a pending match with no determined opponent yet', async () => {
    prisma.tournament.findUnique.mockResolvedValue({
      id: 't1',
      status: 'ONGOING',
      createdById: 'owner',
    });
    prisma.tournamentParticipant.findUnique.mockResolvedValue({
      id: 'p1',
      userId: 'forfeiter',
      tournamentId: 't1',
      status: 'ACTIVE',
    });
    prisma.match.findMany.mockResolvedValue([
      {
        id: 'm2',
        status: 'PENDING',
        player1Id: 'forfeiter',
        player2Id: null,
      },
    ]);

    await participantService.forfeitParticipant('t1', 'forfeiter', {
      id: 'owner',
      roles: ['ORGANIZER'],
    } as any);

    expect(matchService.completeAsWalkover).not.toHaveBeenCalled();
    expect(realtime.emitTournamentUpdated).toHaveBeenCalledWith('t1');
  });

  it('leaves authorization to TournamentAccessGuard (plan 9.3)', () => {
    // This used to assert a ForbiddenException for a non-creator, duplicating a
    // check the route's TournamentAccessGuard already performs. The duplicate
    // was the bug: the guard grants an ACCEPTED co-organizer, the service
    // re-checked `createdById || ADMIN` and threw, so co-organizers saw
    // Forfeit/Replace (canManage said they could) and got 403 every time.
    //
    // The service no longer takes an authorization decision at all, so there is
    // nothing to assert here. Route-level enforcement is covered by
    // route-protection.e2e-spec.ts, which asserts the guard and its
    // @TournamentAccess source are present on both routes.
    expect(true).toBe(true);
  });

  it('is a no-op when the participant is already FORFEITED', async () => {
    prisma.tournament.findUnique.mockResolvedValue({
      id: 't1',
      status: 'ONGOING',
      createdById: 'owner',
    });
    prisma.tournamentParticipant.findUnique.mockResolvedValue({
      id: 'p1',
      userId: 'forfeiter',
      tournamentId: 't1',
      status: 'FORFEITED',
    });

    await participantService.forfeitParticipant('t1', 'forfeiter', {
      id: 'owner',
      roles: ['ORGANIZER'],
    } as any);

    expect(prisma.tournamentParticipant.updateMany).not.toHaveBeenCalled();
    expect(matchService.completeAsWalkover).not.toHaveBeenCalled();
    expect(realtime.emitTournamentUpdated).not.toHaveBeenCalled();
  });

  it('an ADMIN caller who is not the creator is allowed', async () => {
    prisma.tournament.findUnique.mockResolvedValue({
      id: 't1',
      status: 'ONGOING',
      createdById: 'owner',
    });
    prisma.tournamentParticipant.findUnique.mockResolvedValue({
      id: 'p1',
      userId: 'forfeiter',
      tournamentId: 't1',
      status: 'ACTIVE',
    });
    prisma.match.findMany.mockResolvedValue([]);

    await participantService.forfeitParticipant('t1', 'forfeiter', {
      id: 'admin-user',
      roles: ['ADMIN'],
    } as any);

    expect(prisma.tournamentParticipant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'FORFEITED' } }),
    );
    expect(realtime.emitTournamentUpdated).toHaveBeenCalledWith('t1');
  });
});

// Covers FormatsService.generateNextSwissRound: a FORFEITED participant must
// never be paired -- or given a bye -- in a later Swiss/Hybrid round. This is
// the future-rounds half of forfeit handling (the current-round half is
// MatchService.completeAsWalkover, covered above). generateNextSwissRound is
// private, so it is invoked directly via an `any` cast, per the pattern used
// for buildSwissMatchHistory internally.
describe('FormatsService.generateNextSwissRound (forfeited players excluded)', () => {
  let formatsService: FormatsService;
  let prisma: any;
  let matchService: {
    createMatch: jest.Mock;
    activateMatch: jest.Mock;
    creditBye: jest.Mock;
  };
  let leaderboardService: { getLeaderboard: jest.Mock };
  let realtime: { emitTournamentUpdated: jest.Mock };

  beforeEach(() => {
    prisma = {
      match: {
        // Every ACTIVE player already has a prior bye on record, so the
        // "eligible for another bye" list is empty and the fallback logic
        // (`...[...length - 1]`) is what picks the next bye player -- this
        // is exactly the line that must read from the forfeited-filtered
        // list rather than the raw leaderboard order.
        findMany: jest.fn().mockResolvedValue([
          { player1Id: 'A', player2Id: null, isBye: true },
          { player1Id: 'B', player2Id: null, isBye: true },
          { player1Id: 'C', player2Id: null, isBye: true },
          { player1Id: 'X', player2Id: null, isBye: true },
        ]),
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: MatchStatus.PENDING }),
        update: jest.fn().mockResolvedValue({}),
      },
      tournamentParticipant: {
        findMany: jest.fn().mockResolvedValue([{ userId: 'X' }]),
      },
      round: {
        create: jest.fn().mockResolvedValue({ id: 'round-2' }),
      },
    };
    // Transaction-aware code under test calls prisma.$transaction(cb). The
    // mock runs the callback against itself, so the assertions below are
    // unchanged by the wrapping.
    prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));

    matchService = {
      createMatch: jest.fn(async (dto: any) => ({
        id: `match-${dto.matchIndex}`,
        ...dto,
      })),
      activateMatch: jest.fn().mockResolvedValue(undefined),
      // F16: generateNextSwissRound credits the round's bye as a win via creditBye.
      creditBye: jest.fn().mockResolvedValue(undefined),
    };

    leaderboardService = {
      // 'X' is last in leaderboard order -- if the bye fallback ever reverts
      // to reading the unfiltered list, it would pick 'X' here.
      getLeaderboard: jest.fn().mockResolvedValue([
        {
          rank: 1,
          userId: 'A',
          username: 'A',
          points: 3,
          wins: 1,
          losses: 0,
          draws: 0,
          matchWinPct: 1,
        },
        {
          rank: 2,
          userId: 'B',
          username: 'B',
          points: 2,
          wins: 0,
          losses: 0,
          draws: 1,
          matchWinPct: 0.5,
        },
        {
          rank: 3,
          userId: 'C',
          username: 'C',
          points: 1,
          wins: 0,
          losses: 1,
          draws: 0,
          matchWinPct: 0,
        },
        {
          rank: 4,
          userId: 'X',
          username: 'X',
          points: 0,
          wins: 0,
          losses: 1,
          draws: 0,
          matchWinPct: 0,
        },
      ]),
    };

    realtime = { emitTournamentUpdated: jest.fn() };

    formatsService = new FormatsService(
      prisma,
      matchService as unknown as MatchService,
      {} as unknown as TournamentService,
      leaderboardService as unknown as LeaderboardService,
      realtime as unknown as RealtimeGateway,
    );

    // handleMatchCompletion's own behavior is covered elsewhere; stub it so
    // this test stays focused on pairing/bye selection.
    jest
      .spyOn(formatsService as any, 'handleMatchCompletion')
      .mockResolvedValue(undefined);
  });

  it('never pairs or byes a FORFEITED participant in the generated round', async () => {
    await (formatsService as any).generateNextSwissRound('t1', 2, 1);

    expect(prisma.tournamentParticipant.findMany).toHaveBeenCalledWith({
      where: { tournamentId: 't1', status: 'FORFEITED' },
      select: { userId: true },
    });

    expect(matchService.createMatch).toHaveBeenCalled();
    for (const call of matchService.createMatch.mock.calls) {
      const dto = call[0];
      expect(dto.player1Id).not.toBe('X');
      expect(dto.player2Id).not.toBe('X');
    }

    // With 3 ACTIVE players (odd) and all of them already having a bye on
    // record, the fallback must land on the last ACTIVE player -- never fall
    // through to the forfeited 'X'.
    const byeCall = matchService.createMatch.mock.calls.find(
      (c: any) => c[0].isBye,
    );
    expect(byeCall).toBeDefined();
    expect(byeCall[0].player1Id).not.toBe('X');
    expect(byeCall[0].player1Id).toBe('C');
  });
});
