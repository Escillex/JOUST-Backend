import { NotFoundException } from '@nestjs/common';
import { GameRequestStatus, NotificationType, Role } from '@prisma/client';
import { GameController } from '../src/game/game.controller';
import { GameService } from '../src/game/game.service';
import { JwtAuthGuard } from '../src/guards/jwt-auth.guard';
import { RolesGuard } from '../src/guards/roles.guard';
import { ROLES_KEY } from '../src/guards/decorators/roles.decorator';
import type { PrismaService } from 'prisma/prisma.service';

/**
 * "The game I need isn't in the catalog." An organizer cannot create games —
 * only admins can — so this is the hand-off between them, and it is the only
 * escalation path a non-admin has. It had no coverage.
 *
 * Two things matter: an admin actually hears about it (the request is useless
 * if the notification is silently dropped), and the queue stays ADMIN-only,
 * since it carries who asked for what.
 */

const ADMIN_A = 'admin-a';
const ADMIN_B = 'admin-b';
const ORGANIZER = { id: 'org-1', username: 'mira-calder' };

function harness(requests: any[] = []) {
  const rows = new Map(requests.map((r) => [r.id, { ...r }]));
  const created: any[] = [];
  const prisma = {
    gameRequest: {
      create: jest.fn(async ({ data }: any) => {
        created.push(data);
        const row = { id: `req${rows.size + 1}`, status: 'PENDING', ...data };
        rows.set(row.id, row);
        return row;
      }),
      findMany: jest.fn(async () => [...rows.values()]),
      findUnique: jest.fn(async ({ where }: any) => rows.get(where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => {
        const row = { ...rows.get(where.id), ...data };
        rows.set(where.id, row);
        return row;
      }),
    },
    user: {
      findMany: jest.fn(async () => [{ id: ADMIN_A }, { id: ADMIN_B }]),
    },
  };

  const notifications = { notifyAdmins: jest.fn(async () => undefined) };

  const svc = new GameService(
    prisma as unknown as PrismaService,
    notifications as any,
  );
  return { svc, prisma, notifications, created, rows };
}

describe('game requests — an organizer asks', () => {
  it('records the request with the asker and the originating tournament', async () => {
    const { svc, created } = harness();
    await svc.request(
      { name: 'Netrunner', note: 'for Saturday', tournamentId: 't1' } as any,
      ORGANIZER,
    );
    expect(created[0]).toEqual({
      name: 'Netrunner',
      note: 'for Saturday',
      tournamentId: 't1',
      requestedById: ORGANIZER.id,
    });
  });

  it('accepts a request with no note and no tournament', async () => {
    const { svc, created } = harness();
    await svc.request({ name: 'Netrunner' } as any, ORGANIZER);
    expect(created[0]).toMatchObject({ note: null, tournamentId: null });
  });

  it('notifies every admin, not just the first', async () => {
    const { svc, notifications } = harness();
    await svc.request({ name: 'Netrunner' } as any, ORGANIZER);
    expect(notifications.notifyAdmins).toHaveBeenCalledTimes(1);
    expect(notifications.notifyAdmins.mock.calls[0][0]).toMatchObject({
      type: NotificationType.GAME_REQUESTED,
    });
  });

  it('names the game and the asker in the notification', async () => {
    const { svc, notifications } = harness();
    await svc.request(
      { name: 'Netrunner', note: 'for Saturday' } as any,
      ORGANIZER,
    );
    const sent: any = notifications.notifyAdmins.mock.calls[0][0];
    expect(sent.title).toContain('Netrunner');
    expect(sent.body).toContain('mira-calder');
    expect(sent.body).toContain('for Saturday');
  });

  it('links the admin straight to the games tab', async () => {
    const { svc, notifications } = harness();
    await svc.request({ name: 'Netrunner' } as any, ORGANIZER);
    expect((notifications.notifyAdmins.mock.calls[0][0] as any).link).toBe(
      '/admin?tab=GAMES',
    );
  });

  it('falls back to a neutral label when the asker has no handle', async () => {
    const { svc, notifications } = harness();
    await svc.request({ name: 'Netrunner' } as any, {
      id: 'x',
      username: null,
    });
    expect((notifications.notifyAdmins.mock.calls[0][0] as any).body).toContain(
      'An organizer',
    );
  });

  it('confirms to the caller rather than returning the row', async () => {
    // The organizer has no business reading the queue, so the response says
    // only that it was sent.
    const { svc } = harness();
    await expect(
      svc.request({ name: 'Netrunner' } as any, ORGANIZER),
    ).resolves.toEqual({
      message: 'Request sent to admins',
    });
  });
});

describe('game requests — the admin queue', () => {
  it('shows pending first, newest first within a status', async () => {
    const { svc, prisma } = harness();
    await svc.listRequests(GameRequestStatus.PENDING);
    expect(prisma.gameRequest.findMany.mock.calls[0][0].orderBy).toEqual([
      { status: 'asc' },
      { createdAt: 'desc' },
    ]);
  });

  it('filters by status when one is given', async () => {
    const { svc, prisma } = harness();
    await svc.listRequests(GameRequestStatus.DISMISSED);
    expect(prisma.gameRequest.findMany.mock.calls[0][0].where).toEqual({
      status: GameRequestStatus.DISMISSED,
    });
  });

  it('returns every status when none is given', async () => {
    const { svc, prisma } = harness();
    await svc.listRequests(undefined);
    expect(prisma.gameRequest.findMany.mock.calls[0][0].where).toBeUndefined();
  });

  it('carries the originating tournament and requester so it can be resolved in one place', async () => {
    const { svc, prisma } = harness();
    await svc.listRequests();
    const include = prisma.gameRequest.findMany.mock.calls[0][0].include;
    expect(include.tournament.select).toMatchObject({ id: true, name: true });
    expect(include.requestedBy.select).toMatchObject({
      id: true,
      username: true,
    });
  });
});

describe('game requests — resolving', () => {
  const pending = { id: 'req1', name: 'Netrunner', status: 'PENDING' };

  it.each([GameRequestStatus.RESOLVED, GameRequestStatus.DISMISSED])(
    'closes the entry as %s',
    async (status) => {
      const { svc, rows } = harness([pending]);
      await svc.resolveRequest('req1', { status } as any);
      expect(rows.get('req1')!.status).toBe(status);
    },
  );

  it('404s for a request that does not exist', async () => {
    const { svc, prisma } = harness([pending]);
    await expect(
      svc.resolveRequest('nope', { status: GameRequestStatus.RESOLVED } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.gameRequest.update).not.toHaveBeenCalled();
  });

  it('only closes the queue entry — it does not create the game', async () => {
    // Creating the game and reassigning the tournament are separate, deliberate
    // admin actions (POST /games, PATCH /tournaments/:id/game).
    const { svc, prisma } = harness([pending]);
    await svc.resolveRequest('req1', {
      status: GameRequestStatus.RESOLVED,
    } as any);
    expect(prisma.gameRequest.update.mock.calls[0][0].data).toEqual({
      status: GameRequestStatus.RESOLVED,
    });
  });
});

describe('game requests — who may reach them', () => {
  const proto = GameController.prototype as unknown as Record<string, unknown>;
  const guardsOf = (h: unknown) =>
    (Reflect.getMetadata('__guards__', h as object) as unknown[]) ?? [];
  const rolesOf = (h: unknown) =>
    (Reflect.getMetadata(ROLES_KEY, h as object) as Role[]) ?? [];

  it('an organizer may ask, because they cannot create games themselves', () => {
    expect(guardsOf(proto.request)).toEqual(
      expect.arrayContaining([JwtAuthGuard, RolesGuard]),
    );
    expect(rolesOf(proto.request)).toEqual(
      expect.arrayContaining([Role.ORGANIZER, Role.ADMIN]),
    );
  });

  it.each(['listRequests', 'resolveRequest'])(
    '%s is ADMIN-only — the queue names who asked for what',
    (name) => {
      expect(guardsOf(proto[name])).toEqual(
        expect.arrayContaining([JwtAuthGuard, RolesGuard]),
      );
      expect(rolesOf(proto[name])).toEqual([Role.ADMIN]);
    },
  );

  it('the catalog itself stays public', () => {
    expect(guardsOf(proto.list)).toHaveLength(0);
  });
});
