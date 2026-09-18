import { MatchService } from '../src/tournament/match/match.service';
import { TrackerService } from '../src/tournament/match/tracker/tracker.service';
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { MatchStatus } from '@prisma/client';

// Who may SCORE a match is the tournament's `scoreSubmissionRule`, decided in
// MatchService.reportGameResult / TrackerService — the routes are
// JwtAuthGuard-only (route-protection.e2e-spec.ts) because a guard cannot read
// the config, nor who the caller is relative to the match. This is the matrix:
// staff always (result final on the spot); a player of the match under the
// default (SELF_REPORT_ALLOWED), whose deciding result is DEFERRED into pending
// verification for an organizer to review; nobody else. Draws are the one thing
// a player cannot submit at all.
describe('scoring permission', () => {
  const ADMIN = { id: 'admin', roles: ['ADMIN'] };
  const OUTSIDER = { id: 'outsider', roles: ['PLAYER'] };
  const PLAYER1 = { id: 'p1', roles: ['PLAYER'] };
  const PLAYER2 = { id: 'p2', roles: ['PLAYER'] };

  interface MutableMatch {
    id: string;
    status: MatchStatus;
    isBye: boolean;
    player1Id: string | null;
    player2Id: string | null;
    player1Score: number;
    player2Score: number;
    winnerId: string | null;
    reportedWinnerId: string | null;
    phase: number | null;
    round: {
      tournamentId: string;
      tournament: {
        id: string;
        config: Record<string, any> | null;
        format: { config: unknown };
      };
    };
    gameLogs?: any[];
    [key: string]: any;
  }

  // A match whose score fields actually accumulate across reports, because
  // reportGameResult reads back the incremented score from its own update.
  const makeMatch = (
    over: Record<string, any> = {},
    config: Record<string, any> | null = null,
  ): MutableMatch => ({
    id: 'm1',
    status: MatchStatus.ONGOING,
    isBye: false,
    player1Id: 'p1',
    player2Id: 'p2',
    player1Score: 0,
    player2Score: 0,
    winnerId: null,
    reportedWinnerId: null,
    phase: null,
    round: {
      tournamentId: 't1',
      tournament: { id: 't1', config, format: { config: null } },
    },
    gameLogs: [],
    ...over,
  });

  const makePrisma = (match: MutableMatch) => {
    const prisma = {
      match: {
        findUnique: jest.fn().mockResolvedValue(match),
        update: jest.fn(({ data }: any) => {
          if (data.player1Score?.increment)
            match.player1Score += data.player1Score.increment;
          if (data.player2Score?.increment)
            match.player2Score += data.player2Score.increment;
          if ('player1Score' in data && typeof data.player1Score === 'number')
            match.player1Score = data.player1Score;
          if ('player2Score' in data && typeof data.player2Score === 'number')
            match.player2Score = data.player2Score;
          if (data.status) match.status = data.status;
          if ('winnerId' in data) match.winnerId = data.winnerId;
          if ('reportedWinnerId' in data)
            match.reportedWinnerId = data.reportedWinnerId;
          if ('gameLogs' in data) match.gameLogs = data.gameLogs;
          return match;
        }),
      },
      matchGameLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(({ data }: any) => ({
          id: 'log1',
          trackerActive: true,
          gameNumber: 1,
          ...data,
        })),
        update: jest.fn(({ data }: any) => ({ id: 'log1', ...data })),
      },
      // The tournament belongs to somebody else, so only an ADMIN counts as
      // staff below.
      tournament: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ createdById: 'someone-else' }),
        update: jest.fn(),
      },
      tournamentOrganizer: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      tournamentParticipant: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as any;
    // The service uses both transaction forms: array (undoDecidingResult) and
    // callback (updateMatchStats). The array items are evaluated eagerly, so
    // Promise.all resolving them also lets the update mocks keep `match` fresh.
    prisma.$transaction = jest.fn(async (arg: any) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      return arg(prisma);
    });
    return prisma;
  };

  const makeNotificationMock = () =>
    ({
      notify: jest.fn(),
      notifyMany: jest.fn(),
      notifyTournamentOrganizers: jest.fn(),
    }) as any;

  const makeRealtimeMock = () => ({
    emitTournamentUpdated: jest.fn(),
    emitTrackerUpdate: jest.fn(),
  });

  describe('MatchService.reportGameResult', () => {
    const call = (
      match: MutableMatch,
      reporter: any,
      winnerId = 'p1',
      config: Record<string, any> | null = null,
    ) => {
      const prisma = makePrisma(match);
      const notifications = makeNotificationMock();
      const realtime = makeRealtimeMock();
      const service = new MatchService(
        prisma,
        { handleMatchCompletion: jest.fn() } as any,
        notifications,
        realtime as any,
      );
      const run = () => service.reportGameResult('m1', winnerId, reporter);
      return { prisma, notifications, realtime, service, run, match };
    };

    // BO3 → winsNeeded 2, so two identical reports decide the series.
    const permissiveConfig = { bestOf: 3 };
    const strictConfig = { bestOf: 3, scoreSubmissionRule: 'STAFF_ONLY' };

    it('a participant can score games and their deciding result waits for verification', async () => {
      const { run, notifications, realtime, match, prisma } = call(
        makeMatch({}, permissiveConfig),
        PLAYER1,
      );
      const first: any = await run();
      expect(first.matchComplete).toBe(false);
      expect(realtime.emitTournamentUpdated).not.toHaveBeenCalled();
      const second: any = await run();
      expect(second.pendingVerification).toBe(true);
      expect(match.status).toBe(MatchStatus.ONGOING);
      expect(match.winnerId).toBeNull();
      expect(match.reportedWinnerId).toBe('p1');
      // The deciding game never ran the completion path (no COMPLETED write).
      expect(prisma.match.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: MatchStatus.COMPLETED }),
        }),
      );
      expect(notifications.notifyTournamentOrganizers).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({ type: 'SCORE_PENDING' }),
      );
      expect(realtime.emitTournamentUpdated).toHaveBeenCalledWith('t1');
    });

    it('a participant is refused outright when scoreSubmissionRule is STAFF_ONLY', async () => {
      const { run } = call(makeMatch({}, strictConfig), PLAYER1);
      await expect(run()).rejects.toThrow(ForbiddenException);
    });

    it('a non-participant is refused even under the permissive setting', async () => {
      const { run } = call(makeMatch({}, permissiveConfig), OUTSIDER);
      await expect(run()).rejects.toThrow(ForbiddenException);
    });

    it('an unidentified caller is refused', async () => {
      const { run } = call(makeMatch({}, permissiveConfig), undefined);
      await expect(run()).rejects.toThrow(ForbiddenException);
    });

    it('staff score immediately and their deciding result completes the match', async () => {
      const { run, match, notifications, realtime, prisma } = call(
        makeMatch({}, permissiveConfig),
        ADMIN,
      );
      await run();
      const second: any = await run();
      expect(second.matchComplete).toBe(true);
      expect(match.status).toBe(MatchStatus.COMPLETED);
      expect(match.winnerId).toBe('p1');
      expect(match.reportedWinnerId).toBeNull();
      expect(notifications.notifyTournamentOrganizers).not.toHaveBeenCalled();
      expect(prisma.match.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: MatchStatus.COMPLETED }),
        }),
      );
      expect(realtime.emitTournamentUpdated).toHaveBeenCalledWith('t1');
    });

    it('refuses further results once a player-scored result is pending review', async () => {
      const { run } = call(
        makeMatch({ reportedWinnerId: 'p1' }, permissiveConfig),
        PLAYER2,
      );
      await expect(run()).rejects.toThrow(BadRequestException);
    });
  });

  describe('MatchService.verifyResult', () => {
    it('finalizes a deferred score and emits tournament:updated', async () => {
      const match = makeMatch({ reportedWinnerId: 'p1' }, { bestOf: 3 });
      const prisma = makePrisma(match);
      const notifications = makeNotificationMock();
      const realtime = makeRealtimeMock();
      const service = new MatchService(
        prisma,
        { handleMatchCompletion: jest.fn() } as any,
        notifications,
        realtime as any,
      );
      await service.verifyResult('m1');
      expect(match.status).toBe(MatchStatus.COMPLETED);
      expect(match.winnerId).toBe('p1');
      expect(realtime.emitTournamentUpdated).toHaveBeenCalledWith('t1');
    });
  });

  describe('MatchService.reportDraw', () => {
    const drawConfig = {
      bestOf: 1,
      allowDraw: true,
      scoreSubmissionRule: 'SELF_REPORT_ALLOWED',
    };

    it('a participant cannot record a draw — staff must confirm it', async () => {
      const match = {
        ...makeMatch({}, drawConfig),
        round: {
          tournamentId: 't1',
          tournament: {
            id: 't1',
            config: drawConfig,
            format: { config: null },
            system: 'SWISS',
          },
        },
      };
      const prisma = makePrisma(match);
      const notifications = makeNotificationMock();
      const realtime = makeRealtimeMock();
      const service = new MatchService(
        prisma,
        {} as any,
        notifications,
        realtime as any,
      );
      await expect(service.reportDraw('m1', PLAYER1)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('staff can still record a draw', async () => {
      const match = {
        ...makeMatch({}, drawConfig),
        round: {
          tournamentId: 't1',
          tournament: {
            id: 't1',
            config: drawConfig,
            format: { config: null },
            system: 'SWISS',
          },
        },
      };
      const prisma = makePrisma(match);
      const notifications = makeNotificationMock();
      const realtime = makeRealtimeMock();
      const service = new MatchService(
        prisma,
        { handleMatchCompletion: jest.fn() } as any,
        notifications,
        realtime as any,
      );
      const result: any = await service.reportDraw('m1', ADMIN);
      expect(result.draw).toBe(true);
      expect(match.status).toBe(MatchStatus.COMPLETED);
      expect(realtime.emitTournamentUpdated).toHaveBeenCalledWith('t1');
    });
  });

  describe('TrackerService.openTracker', () => {
    const makeTracker = (match: MutableMatch) => {
      const prisma = makePrisma(match);
      const realtime = {
        emitTournamentUpdated: jest.fn(),
        emitTrackerUpdate: jest.fn(),
      } as any;
      const matchService = {
        reportGameResult: jest.fn(),
        reportDraw: jest.fn(),
      } as any;
      const service = new TrackerService(prisma, matchService, realtime);
      return { prisma, service, realtime };
    };

    const open = (match: MutableMatch, caller: any) => {
      const { prisma, service } = makeTracker(match);
      return {
        prisma,
        run: () => service.openTracker('m1', {} as any, caller),
      };
    };

    it('a participant can open a game under the default (permissive) setting', async () => {
      const { prisma, run } = open(makeMatch({}, { bestOf: 3 }), PLAYER1);
      await run();
      expect(prisma.matchGameLog.create).toHaveBeenCalled();
    });

    it('a participant cannot open a game when scoreSubmissionRule is STAFF_ONLY', async () => {
      const { run } = open(
        makeMatch({}, { bestOf: 3, scoreSubmissionRule: 'STAFF_ONLY' }),
        PLAYER1,
      );
      await expect(run()).rejects.toThrow(ForbiddenException);
    });

    it('an outsider cannot open a game', async () => {
      const { run } = open(makeMatch({}, { bestOf: 3 }), OUTSIDER);
      await expect(run()).rejects.toThrow(ForbiddenException);
    });

    it('refuses while a player-scored result awaits verification', async () => {
      const { run } = open(
        makeMatch({ reportedWinnerId: 'p1' }, { bestOf: 3 }),
        ADMIN,
      );
      await expect(run()).rejects.toThrow(BadRequestException);
    });
  });

  describe('TrackerService.updateTracker', () => {
    const makeTracker = (match: MutableMatch) => {
      const prisma = makePrisma(match);
      prisma.matchGameLog.findFirst = jest.fn().mockResolvedValue({
        id: 'log1',
        trackerActive: true,
        gameNumber: 1,
        mode: 'HP',
        startingValue: 20,
        player1Value: 20,
        player2Value: 20,
      });
      const realtime = {
        emitTournamentUpdated: jest.fn(),
        emitTrackerUpdate: jest.fn(),
      } as any;
      const matchService = {
        reportGameResult: jest.fn(),
        reportDraw: jest.fn(),
      } as any;
      const service = new TrackerService(prisma, matchService, realtime);
      return service;
    };

    it('a participant may write their own slot even under STAFF_ONLY', async () => {
      const service = makeTracker(
        makeMatch({}, { scoreSubmissionRule: 'STAFF_ONLY' }),
      );
      await expect(
        service.updateTracker('m1', { player1Value: 15 }, PLAYER1),
      ).resolves.toBeDefined();
    });

    it('a participant may NOT write the opponent slot under STAFF_ONLY', async () => {
      const service = makeTracker(
        makeMatch({}, { scoreSubmissionRule: 'STAFF_ONLY' }),
      );
      await expect(
        service.updateTracker('m1', { player2Value: 5 }, PLAYER1),
      ).rejects.toThrow(ForbiddenException);
    });

    it('under the permissive setting either player may write either side', async () => {
      const service = makeTracker(makeMatch({}, {}));
      await expect(
        service.updateTracker('m1', { player2Value: 5 }, PLAYER1),
      ).resolves.toBeDefined();
      await expect(
        service.updateTracker('m1', { player1Value: 18 }, PLAYER2),
      ).resolves.toBeDefined();
    });

    it('an outsider is refused', async () => {
      const service = makeTracker(makeMatch({}, {}));
      await expect(
        service.updateTracker('m1', { player1Value: 5 }, OUTSIDER),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('TrackerService.submitGame', () => {
    it('forwards the caller to reportGameResult so the authority is shared', async () => {
      const match = makeMatch({}, { bestOf: 3 });
      const prisma = makePrisma(match);
      prisma.matchGameLog.findFirst = jest.fn().mockResolvedValue({
        id: 'log1',
        trackerActive: true,
        gameNumber: 1,
        mode: 'HP',
        startingValue: 20,
        player1Value: 20,
        player2Value: 20,
      });
      const realtime = {
        emitTournamentUpdated: jest.fn(),
        emitTrackerUpdate: jest.fn(),
      } as any;
      const matchService = {
        reportGameResult: jest
          .fn()
          .mockResolvedValue({ pendingVerification: true }),
        reportDraw: jest.fn(),
      } as any;
      const service = new TrackerService(prisma, matchService, realtime);
      await service.submitGame('m1', { winnerId: 'p1' } as any, PLAYER1);
      expect(matchService.reportGameResult).toHaveBeenCalledWith(
        'm1',
        'p1',
        PLAYER1,
      );
      // The game log is only closed AFTER the result succeeded (F5).
      expect(prisma.matchGameLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ trackerActive: false }),
        }),
      );
    });
  });

  describe('MatchService.rejectReportedResult', () => {
    const call = (match: MutableMatch) => {
      const prisma = makePrisma(match);
      const notifications = makeNotificationMock();
      const realtime = makeRealtimeMock();
      const service = new MatchService(
        prisma,
        { handleMatchCompletion: jest.fn() } as any,
        notifications,
        realtime as any,
      );
      const run = () => service.rejectReportedResult('m1');
      return { prisma, notifications, realtime, service, run, match };
    };

    it('takes back the deciding game: score −1 and the newest closed log reopened', async () => {
      const { run, prisma, match } = call(
        makeMatch(
          {
            player1Score: 1,
            player2Score: 1,
            reportedWinnerId: 'p2',
            gameLogs: [
              {
                id: 'log1',
                gameNumber: 1,
                trackerActive: false,
                winnerId: 'p2',
                completedAt: new Date(),
              },
              {
                id: 'log3',
                gameNumber: 3,
                trackerActive: false,
                winnerId: 'p2',
                completedAt: new Date(),
              },
            ],
          },
          { bestOf: 3 },
        ),
      );
      await run();
      expect(prisma.match.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            reportedWinnerId: null,
            player1Score: 1,
            player2Score: 0,
          }),
        }),
      );
      // Only the deciding (newest closed) game is reopened, not the whole series.
      expect(prisma.matchGameLog.update).toHaveBeenCalledTimes(1);
      expect(prisma.matchGameLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'log3' },
          data: { trackerActive: true, winnerId: null, completedAt: null },
        }),
      );
      expect(match.player2Score).toBe(0);
    });

    it('a pending self-report with no tracker game still rolls the win back', async () => {
      const { run, prisma } = call(
        makeMatch(
          {
            player1Score: 1,
            player2Score: 0,
            reportedWinnerId: 'p1',
            gameLogs: [],
          },
          { bestOf: 1 },
        ),
      );
      await run();
      expect(prisma.match.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            reportedWinnerId: null,
            player1Score: 0,
            player2Score: 0,
          }),
        }),
      );
      expect(prisma.matchGameLog.update).not.toHaveBeenCalled();
    });

    it('refuses when there is nothing pending to reject', async () => {
      const { run } = call(makeMatch({}, { bestOf: 3 }));
      await expect(run()).rejects.toThrow(BadRequestException);
    });

    it('refuses on a completed match', async () => {
      const { run } = call(
        makeMatch(
          { status: MatchStatus.COMPLETED, reportedWinnerId: 'p1' },
          { bestOf: 3 },
        ),
      );
      await expect(run()).rejects.toThrow(BadRequestException);
    });
  });

  describe('MatchService.resetMatch', () => {
    const call = (match: MutableMatch) => {
      const prisma = makePrisma(match);
      const notifications = makeNotificationMock();
      const realtime = makeRealtimeMock();
      const service = new MatchService(
        prisma,
        { handleMatchCompletion: jest.fn() } as any,
        notifications,
        realtime as any,
      );
      const run = () => service.resetMatch('m1');
      return { prisma, notifications, realtime, service, run, match };
    };

    it('returns a completed match to ONGOING and takes back the deciding game', async () => {
      const { run, prisma, match } = call(
        makeMatch(
          {
            status: MatchStatus.COMPLETED,
            winnerId: 'p2',
            player1Score: 1,
            player2Score: 2,
            gameLogs: [
              {
                id: 'log1',
                gameNumber: 1,
                trackerActive: false,
                winnerId: 'p2',
                completedAt: new Date(),
              },
              {
                id: 'log3',
                gameNumber: 3,
                trackerActive: false,
                winnerId: 'p2',
                completedAt: new Date(),
              },
            ],
          },
          { bestOf: 3 },
        ),
      );
      await run();
      expect(match.status).toBe(MatchStatus.ONGOING);
      expect(prisma.match.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: MatchStatus.ONGOING,
            winnerId: null,
            completedAt: null,
            reportedWinnerId: null,
            player1Score: 1,
            player2Score: 1,
          }),
        }),
      );
      expect(prisma.matchGameLog.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'log3' } }),
      );
    });

    it('reopens a completed tournament as ONGOING', async () => {
      const match = {
        ...makeMatch({}, { bestOf: 3 }),
        status: MatchStatus.COMPLETED,
        winnerId: 'p1',
        player1Score: 2,
        player2Score: 0,
        gameLogs: [
          {
            id: 'log2',
            gameNumber: 2,
            trackerActive: false,
            winnerId: 'p1',
            completedAt: new Date(),
          },
        ],
        round: {
          tournamentId: 't1',
          tournament: {
            id: 't1',
            status: 'COMPLETED',
            config: { bestOf: 3 },
            format: { config: null },
          },
        },
      };
      const { run, prisma } = call(match);
      await run();
      expect(prisma.tournament.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'ONGOING',
            completedAt: null,
            winnerId: null,
          }),
        }),
      );
    });

    it('refuses a match that is not completed', async () => {
      const { run } = call(makeMatch({}, { bestOf: 3 }));
      await expect(run()).rejects.toThrow(BadRequestException);
    });
  });
});
