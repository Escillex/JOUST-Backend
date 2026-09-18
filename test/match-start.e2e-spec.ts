import { MatchService } from '../src/tournament/match/match.service';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { MatchStatus } from '@prisma/client';

// Who may start a match is the tournament's `matchStartWho` config, decided in
// MatchService.startMatch — the route is JwtAuthGuard-only (see
// route-protection.e2e-spec.ts) because a guard cannot read the config. This is
// the matrix: staff always, a player of the match under the default
// (STAFF_AND_PARTICIPANTS), nobody else. A bye or a one-sided match has nothing
// to start even for staff.
describe('startMatch authorization', () => {
  const makeService = (match: any) => {
    const prisma = {
      match: {
        findUnique: jest.fn().mockResolvedValue(match),
        update: jest.fn(({ data }: any) => ({ ...match, ...data })),
      },
      // The tournament belongs to somebody else, so only a user whose roles
      // contain ADMIN counts as staff below.
      tournament: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ createdById: 'someone-else' }),
      },
      tournamentOrganizer: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    } as any;
    prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));
    const notifications = { notify: jest.fn(), notifyMany: jest.fn() } as any;
    const realtime = { emitTournamentUpdated: jest.fn() } as any;
    const service = new MatchService(
      prisma,
      {} as any,
      notifications,
      realtime,
    );
    return { prisma, notifications, realtime, service };
  };

  const makeMatch = (
    over: Record<string, any> = {},
    config: Record<string, any> | null = null,
  ) => ({
    id: 'm1',
    status: MatchStatus.PENDING,
    isBye: false,
    player1Id: 'p1',
    player2Id: 'p2',
    phase: null,
    round: {
      tournamentId: 't1',
      tournament: { id: 't1', config, format: { config: null } },
    },
    ...over,
  });

  const ADMIN = { id: 'admin', roles: ['ADMIN'] };
  const OUTSIDER = { id: 'outsider', roles: ['PLAYER'] };
  const PLAYER1 = { id: 'p1', roles: ['PLAYER'] };

  it('staff can always start', async () => {
    const { prisma, realtime, service } = makeService(makeMatch());
    await service.startMatch('m1', ADMIN);
    expect(prisma.match.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: MatchStatus.ONGOING }),
      }),
    );
    expect(realtime.emitTournamentUpdated).toHaveBeenCalledWith('t1');
  });

  it('a participant can start under the default (permissive) setting', async () => {
    const { prisma, realtime, service } = makeService(makeMatch());
    await service.startMatch('m1', PLAYER1);
    expect(prisma.match.update).toHaveBeenCalled();
    expect(realtime.emitTournamentUpdated).toHaveBeenCalledWith('t1');
  });

  it('a participant is refused when matchStartWho is STAFF', async () => {
    const { service } = makeService(makeMatch({}, { matchStartWho: 'STAFF' }));
    await expect(service.startMatch('m1', PLAYER1)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('a non-participant is refused even under the permissive setting', async () => {
    const { service } = makeService(makeMatch());
    await expect(service.startMatch('m1', OUTSIDER)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('an unidentified caller is refused', async () => {
    const { service } = makeService(makeMatch());
    await expect(service.startMatch('m1')).rejects.toThrow(ForbiddenException);
  });

  it('a bye still cannot be started', async () => {
    const { service } = makeService(makeMatch({ isBye: true }));
    await expect(service.startMatch('m1', ADMIN)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('a match with only one player still cannot be started', async () => {
    const { service } = makeService(makeMatch({ player2Id: null }));
    await expect(service.startMatch('m1', ADMIN)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('an already-completed match cannot be started', async () => {
    const { service } = makeService(makeMatch({ status: 'COMPLETED' }));
    await expect(service.startMatch('m1', ADMIN)).rejects.toThrow(
      BadRequestException,
    );
  });
});
