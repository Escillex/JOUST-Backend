import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TournamentAccessGuard } from '../src/guards/tournament-access.guard';
import { checkTournamentAccess } from '../src/guards/tournament-access.util';
import type { TournamentAccessSource } from '../src/guards/decorators/tournament-access.decorator';
import { TournamentService } from '../src/tournament/tournament.service';

const CREATOR = {
  id: 'creator',
  email: null,
  username: 'c',
  roles: ['ORGANIZER'],
} as any;
const OTHER = {
  id: 'other',
  email: null,
  username: 'o',
  roles: ['ORGANIZER'],
} as any;
const ADMIN = {
  id: 'admin',
  email: null,
  username: 'a',
  roles: ['ADMIN'],
} as any;

// Minimal Prisma stand-in: one tournament, one match pointing at it.
const makePrisma = (createdById: string | null) =>
  ({
    tournament: {
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(where.id === 't1' ? { createdById } : null),
      ),
    },
    match: {
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(
          where.id === 'm1' ? { round: { tournamentId: 't1' } } : null,
        ),
      ),
    },
    // Nobody is co-organizer staff in these cases; the co-organizer clause has
    // its own describe below.
    tournamentOrganizer: { findUnique: jest.fn().mockResolvedValue(null) },
  }) as any;

const makeContext = (
  params: Record<string, string>,
  user: any,
): ExecutionContext =>
  ({
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => ({ params, user }) }),
  }) as unknown as ExecutionContext;

const makeReflector = (source: TournamentAccessSource | undefined) =>
  ({ getAllAndOverride: () => source }) as unknown as Reflector;

describe('checkTournamentAccess', () => {
  it('allows the creator', async () => {
    await expect(
      checkTournamentAccess(makePrisma('creator'), 't1', CREATOR),
    ).resolves.toBe('ALLOWED');
  });

  it('allows an ADMIN who is not the creator', async () => {
    await expect(
      checkTournamentAccess(makePrisma('creator'), 't1', ADMIN),
    ).resolves.toBe('ALLOWED');
  });

  it('denies an unrelated organizer', async () => {
    await expect(
      checkTournamentAccess(makePrisma('creator'), 't1', OTHER),
    ).resolves.toBe('DENIED');
  });

  it('denies an anonymous caller', async () => {
    await expect(
      checkTournamentAccess(makePrisma('creator'), 't1', undefined),
    ).resolves.toBe('DENIED');
  });

  it('reports NOT_FOUND for a missing tournament, even for an ADMIN', async () => {
    await expect(
      checkTournamentAccess(makePrisma('creator'), 'nope', ADMIN),
    ).resolves.toBe('NOT_FOUND');
  });

  it('denies a non-admin when the creator was deleted (orphaned tournament)', async () => {
    await expect(
      checkTournamentAccess(makePrisma(null), 't1', OTHER),
    ).resolves.toBe('DENIED');
  });

  it('still allows an ADMIN on an orphaned tournament', async () => {
    await expect(
      checkTournamentAccess(makePrisma(null), 't1', ADMIN),
    ).resolves.toBe('ALLOWED');
  });
});

describe('TournamentAccessGuard', () => {
  it('resolves a tournament id from the "id" param', async () => {
    const guard = new TournamentAccessGuard(
      makeReflector('id'),
      makePrisma('creator'),
    );
    await expect(
      guard.canActivate(makeContext({ id: 't1' }, CREATOR)),
    ).resolves.toBe(true);
  });

  it('resolves a tournament id from the "tournamentId" param', async () => {
    const guard = new TournamentAccessGuard(
      makeReflector('tournamentId'),
      makePrisma('creator'),
    );
    await expect(
      guard.canActivate(makeContext({ tournamentId: 't1' }, CREATOR)),
    ).resolves.toBe(true);
  });

  it('walks match -> round -> tournament for "match:id"', async () => {
    const guard = new TournamentAccessGuard(
      makeReflector('match:id'),
      makePrisma('creator'),
    );
    await expect(
      guard.canActivate(makeContext({ id: 'm1' }, CREATOR)),
    ).resolves.toBe(true);
  });

  it('rejects an unrelated organizer with 403', async () => {
    const guard = new TournamentAccessGuard(
      makeReflector('id'),
      makePrisma('creator'),
    );
    await expect(
      guard.canActivate(makeContext({ id: 't1' }, OTHER)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('throws 404 when the tournament does not exist', async () => {
    const guard = new TournamentAccessGuard(
      makeReflector('id'),
      makePrisma('creator'),
    );
    await expect(
      guard.canActivate(makeContext({ id: 'nope' }, ADMIN)),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws 404 when the match does not exist', async () => {
    const guard = new TournamentAccessGuard(
      makeReflector('match:id'),
      makePrisma('creator'),
    );
    await expect(
      guard.canActivate(makeContext({ id: 'nope' }, ADMIN)),
    ).rejects.toThrow(NotFoundException);
  });

  it('fails closed when the route has no @TournamentAccess decorator', async () => {
    const guard = new TournamentAccessGuard(
      makeReflector(undefined),
      makePrisma('creator'),
    );
    await expect(
      guard.canActivate(makeContext({ id: 't1' }, ADMIN)),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('getTournament canManage', () => {
  // The read is public, so canManage is what tells an authenticated caller
  // whether the management endpoints will accept them.
  const build = (createdById: string | null) => {
    const prisma = {
      tournament: {
        findUnique: jest.fn().mockResolvedValue({
          id: 't1',
          createdById,
          participants: [],
          rounds: [],
        }),
      },
      tournamentOrganizer: { findUnique: jest.fn().mockResolvedValue(null) },
    } as any;
    return new TournamentService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      { notify: jest.fn(), notifyMany: jest.fn() } as any,
    );
  };

  it('is true for the creator', async () => {
    await expect(
      build('creator').getTournament('t1', CREATOR),
    ).resolves.toMatchObject({
      canManage: true,
    });
  });

  it('is false for an unrelated organizer', async () => {
    await expect(
      build('creator').getTournament('t1', OTHER),
    ).resolves.toMatchObject({
      canManage: false,
    });
  });

  it('is false for an anonymous reader', async () => {
    await expect(
      build('creator').getTournament('t1', undefined),
    ).resolves.toMatchObject({ canManage: false });
  });

  it('is true for an ADMIN', async () => {
    await expect(
      build('creator').getTournament('t1', ADMIN),
    ).resolves.toMatchObject({
      canManage: true,
    });
  });

  it('is false for a non-admin on an orphaned tournament', async () => {
    await expect(build(null).getTournament('t1', OTHER)).resolves.toMatchObject(
      {
        canManage: false,
      },
    );
  });
});

describe('getAllTournaments manageable filter', () => {
  const buildService = () => {
    const prisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
      },
      tournament: {
        updateMany: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as any;
    return {
      prisma,
      service: new TournamentService(
        prisma,
        {} as any,
        {} as any,
        {} as any,
        { notify: jest.fn(), notifyMany: jest.fn() } as any,
      ),
    };
  };

  // The manageable filter and the privacy filter (plan 9.15) are combined under
  // AND when both apply, so this reads the manageable clause out of that.
  const manageableClause = (arg: any) =>
    arg.where.AND ? arg.where.AND[0] : arg.where;

  it('filters to tournaments the caller creates or co-manages', async () => {
    const { prisma, service } = buildService();
    await service.getAllTournaments(CREATOR, true);
    const arg = prisma.tournament.findMany.mock.calls[0][0];
    expect(manageableClause(arg).OR).toEqual(
      expect.arrayContaining([
        { createdById: 'creator' },
        {
          organizers: {
            some: { userId: 'creator', status: 'ACCEPTED' },
          },
        },
      ]),
    );
  });

  it('does not filter for an ADMIN', async () => {
    const { prisma, service } = buildService();
    await service.getAllTournaments(ADMIN, true);
    const arg = prisma.tournament.findMany.mock.calls[0][0];
    expect(arg?.where?.OR).toBeUndefined();
  });

  it('applies no MANAGEABLE filter when the flag is absent', async () => {
    const { prisma, service } = buildService();
    await service.getAllTournaments(CREATOR, false);
    const arg = prisma.tournament.findMany.mock.calls[0][0];
    // The privacy filter still applies (9.15), so `where` is present — but it
    // must not be scoped to what this user manages.
    expect(arg?.where?.AND).toBeUndefined();
    expect(arg?.where?.OR).toEqual(
      expect.arrayContaining([{ isPrivate: false }]),
    );
  });

  // ─── Privacy filter (plan 9.15) ──────────────────────────────────
  // `isPrivate` used to be written and then filtered on by nothing, so a
  // tournament offered as "Private Invite" was listed publicly to everyone.

  it('hides private tournaments from an anonymous browser', async () => {
    const { prisma, service } = buildService();
    await service.getAllTournaments(undefined, false);
    const arg = prisma.tournament.findMany.mock.calls[0][0];
    // Anonymous: the ONLY thing they may see is the non-private set.
    expect(arg.where.OR).toEqual([{ isPrivate: false }]);
  });

  it('still shows a signed-in user their own and entered private tournaments', async () => {
    const { prisma, service } = buildService();
    await service.getAllTournaments(CREATOR, false);
    const arg = prisma.tournament.findMany.mock.calls[0][0];
    expect(arg.where.OR).toEqual(
      expect.arrayContaining([
        { isPrivate: false },
        { createdById: 'creator' },
        { participants: { some: { userId: 'creator' } } },
      ]),
    );
  });

  it('does not restrict an ADMIN by privacy', async () => {
    const { prisma, service } = buildService();
    await service.getAllTournaments(ADMIN, false);
    const arg = prisma.tournament.findMany.mock.calls[0][0];
    expect(arg?.where).toBeUndefined();
  });

  it('applies no MANAGEABLE filter for an anonymous caller', async () => {
    const { prisma, service } = buildService();
    await service.getAllTournaments(undefined, true);
    const arg = prisma.tournament.findMany.mock.calls[0][0];
    // No AND wrapper means the manageable clause was never added. The privacy
    // filter below is the only restriction, and it MUST be there — this test
    // previously asserted no filter at all, which is exactly the hole in 9.15.
    expect(arg?.where?.AND).toBeUndefined();
    expect(arg.where.OR).toEqual([{ isPrivate: false }]);
  });
});

describe('checkTournamentAccess with co-organizers', () => {
  const makePrismaWithStaff = (staffStatus: string | null) =>
    ({
      tournament: {
        findUnique: jest.fn(({ where }: any) =>
          Promise.resolve(
            where.id === 't1' ? { createdById: 'creator' } : null,
          ),
        ),
      },
      tournamentOrganizer: {
        findUnique: jest.fn(() =>
          Promise.resolve(staffStatus ? { status: staffStatus } : null),
        ),
      },
    }) as any;

  it('allows an ACCEPTED co-organizer', async () => {
    await expect(
      checkTournamentAccess(makePrismaWithStaff('ACCEPTED'), 't1', OTHER),
    ).resolves.toBe('ALLOWED');
  });

  it('denies a PENDING invitee - access begins on acceptance, not on invitation', async () => {
    await expect(
      checkTournamentAccess(makePrismaWithStaff('PENDING'), 't1', OTHER),
    ).resolves.toBe('DENIED');
  });

  it('denies a DECLINED invitee', async () => {
    await expect(
      checkTournamentAccess(makePrismaWithStaff('DECLINED'), 't1', OTHER),
    ).resolves.toBe('DENIED');
  });

  it('denies someone with no row at all', async () => {
    await expect(
      checkTournamentAccess(makePrismaWithStaff(null), 't1', OTHER),
    ).resolves.toBe('DENIED');
  });

  it('does not query staff for the creator - the cheap clauses win first', async () => {
    const prisma = makePrismaWithStaff('ACCEPTED');
    await checkTournamentAccess(prisma, 't1', CREATOR);
    expect(prisma.tournamentOrganizer.findUnique).not.toHaveBeenCalled();
  });
});
