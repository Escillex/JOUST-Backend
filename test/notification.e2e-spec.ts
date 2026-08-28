import { RealtimeGateway } from '../src/realtime/realtime.gateway';
import { NotificationService } from '../src/notification/notification.service';
import { NotificationType } from '@prisma/client';
import { MatchService } from '../src/tournament/match/match.service';
import { ParticipantService } from '../src/tournament/participant/participant.service';

// The gateway is the only place a notification reaches a specific person, so
// the room it joins during the handshake is the security boundary: an anonymous
// socket must never end up in somebody's private room.
describe('RealtimeGateway user rooms', () => {
  const makeGateway = (verify: () => any) => {
    const gateway = new RealtimeGateway({ verify } as any);
    const emit = jest.fn();
    gateway.server = { to: jest.fn(() => ({ emit })) } as any;
    return { gateway, emit };
  };

  // SOCKET SECURITY: a trusted `origin` is now part of what earns a socket its
  // private room, so these clients must present one — see the origin gate in
  // realtime.gateway.ts. The refusal cases live in realtime.gateway.spec.ts.
  const makeClient = (cookie?: string, origin = 'http://localhost:3000') =>
    ({
      handshake: { headers: { cookie, origin } },
      data: {} as Record<string, unknown>,
      join: jest.fn(),
    }) as any;

  it('joins the private user room when the cookie verifies', () => {
    const { gateway } = makeGateway(() => ({ id: 'u1', roles: ['PLAYER'] }));
    const client = makeClient('token=good');
    gateway.handleConnection(client);
    expect(client.join).toHaveBeenCalledWith('user:u1');
  });

  it('does not join the private room from an untrusted origin, even with a good cookie', () => {
    const { gateway } = makeGateway(() => ({ id: 'u1', roles: ['PLAYER'] }));
    const client = makeClient('token=good', 'https://evil.example');
    gateway.handleConnection(client);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('does not join any user room for an anonymous socket', () => {
    const { gateway } = makeGateway(() => {
      throw new Error('no token');
    });
    const client = makeClient(undefined);
    gateway.handleConnection(client);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('does not join a user room when the token is invalid', () => {
    const { gateway } = makeGateway(() => {
      throw new Error('bad token');
    });
    const client = makeClient('token=bad');
    gateway.handleConnection(client);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('emitNotification targets that user room only', () => {
    const { gateway, emit } = makeGateway(() => ({ id: 'u1', roles: [] }));
    gateway.emitNotification('u1', {
      id: 'n1',
      type: 'MATCH_READY',
      title: 'Your match is ready',
      createdAt: new Date(),
    });
    expect(gateway.server.to).toHaveBeenCalledWith('user:u1');
    expect(emit).toHaveBeenCalledWith(
      'notification:new',
      expect.objectContaining({ id: 'n1' }),
    );
  });
});

describe('NotificationService', () => {
  const build = (overrides: Record<string, any> = {}) => {
    const prisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]),
      },
      notification: {
        create: jest.fn(({ data }: any) =>
          Promise.resolve({ id: 'n1', ...data }),
        ),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      ...overrides,
    } as any;
    // Transaction-aware code under test calls prisma.$transaction(cb). The
    // mock runs the callback against itself, so the assertions below are
    // unchanged by the wrapping.
    prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));
    const realtime = { emitNotification: jest.fn() } as any;
    return {
      prisma,
      realtime,
      service: new NotificationService(prisma, realtime),
    };
  };

  it('writes a row and pushes it to the recipient', async () => {
    const { prisma, realtime, service } = build();
    await service.notify({
      userId: 'u1',
      type: NotificationType.MATCH_READY,
      title: 'Your match is ready',
      link: '/tournaments/t1/bracket',
    });
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'u1',
          title: 'Your match is ready',
        }),
      }),
    );
    expect(realtime.emitNotification).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ id: 'n1' }),
    );
  });

  it('skips guests, who have no login to return to', async () => {
    const { prisma, realtime, service } = build({
      user: { findMany: jest.fn().mockResolvedValue([]) },
    });
    await service.notifyMany(['guest1'], {
      type: NotificationType.TOURNAMENT_STARTED,
      title: 'Tournament started',
    });
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(realtime.emitNotification).not.toHaveBeenCalled();
  });

  it('writes one row per non-guest recipient', async () => {
    const { prisma, service } = build();
    await service.notifyMany(['u1', 'u2'], {
      type: NotificationType.TOURNAMENT_STARTED,
      title: 'Tournament started',
    });
    expect(prisma.notification.create).toHaveBeenCalledTimes(2);
  });

  it('never throws into its caller when the write fails', async () => {
    const { service } = build({
      notification: {
        create: jest.fn().mockRejectedValue(new Error('db down')),
        findMany: jest.fn(),
        count: jest.fn(),
        updateMany: jest.fn(),
      },
    });
    // A failed notification must not fail the match result that triggered it.
    await expect(
      service.notify({
        userId: 'u1',
        type: NotificationType.MATCH_READY,
        title: 'x',
      }),
    ).resolves.toBeUndefined();
  });

  it('markRead only touches the caller own row', async () => {
    const { prisma, service } = build();
    await service.markRead('u1', 'n1');
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: 'n1', userId: 'u1' },
      data: { read: true },
    });
  });

  it('markAllRead only touches the caller unread rows', async () => {
    const { prisma, service } = build();
    await service.markAllRead('u1');
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', read: false },
      data: { read: true },
    });
  });

  it('list returns items with an unread count', async () => {
    const { prisma, service } = build();
    prisma.notification.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    prisma.notification.count.mockResolvedValue(2);
    const result = await service.list('u1', { take: 20 });
    expect(result.items).toHaveLength(2);
    expect(result.unreadCount).toBe(2);
    expect(result.nextCursor).toBeNull();
  });

  it('returns a cursor when more rows exist than were asked for', async () => {
    const { prisma, service } = build();
    prisma.notification.findMany.mockResolvedValue([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ]);
    const result = await service.list('u1', { take: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBe('b');
  });
});

describe('notification write sites', () => {
  // MATCH_READY now fires from startMatch (the organizer explicitly starting a
  // match) — nothing auto-activates any more, so advancement no longer notifies.
  const makeMatchService = (match: any) => {
    const prisma = {
      match: {
        findUnique: jest.fn().mockResolvedValue(match),
        update: jest.fn().mockResolvedValue(match),
      },
    } as any;
    // Transaction-aware code under test calls prisma.$transaction(cb). The
    // mock runs the callback against itself, so the assertions below are
    // unchanged by the wrapping.
    prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));
    const notifications = { notify: jest.fn(), notifyMany: jest.fn() } as any;
    const service = new MatchService(prisma, {} as any, notifications);
    return { prisma, notifications, service };
  };

  it('startMatch notifies both players when the organizer starts the match', async () => {
    const { notifications, service } = makeMatchService({
      id: 'm1',
      status: 'PENDING',
      isBye: false,
      player1Id: 'a',
      player2Id: 'b',
      round: { tournamentId: 't1' },
    });
    await service.startMatch('m1');
    expect(notifications.notifyMany).toHaveBeenCalledWith(
      ['a', 'b'],
      expect.objectContaining({
        type: NotificationType.MATCH_READY,
        link: '/tournaments/t1/bracket',
      }),
    );
  });

  it('startMatch refuses a match that is missing a player (nothing to start, no ping)', async () => {
    const { notifications, service } = makeMatchService({
      id: 'm1',
      status: 'PENDING',
      isBye: false,
      player1Id: 'a',
      player2Id: null,
      round: { tournamentId: 't1' },
    });
    await expect(service.startMatch('m1')).rejects.toBeDefined();
    expect(notifications.notifyMany).not.toHaveBeenCalled();
  });

  it('startMatch sends nothing when the match has no resolvable tournament', async () => {
    const { notifications, service } = makeMatchService({
      id: 'm1',
      status: 'PENDING',
      isBye: false,
      player1Id: 'a',
      player2Id: 'b',
      round: null,
    });
    await service.startMatch('m1');
    expect(notifications.notifyMany).not.toHaveBeenCalled();
  });

  it('tells a player they were forfeited', async () => {
    const prisma = {
      tournament: {
        findUnique: jest.fn().mockResolvedValue({
          id: 't1',
          status: 'ONGOING',
          name: 'Summer Cup',
          createdById: 'creator',
        }),
      },
      tournamentParticipant: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1', status: 'ACTIVE' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      match: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    // Transaction-aware code under test calls prisma.$transaction(cb). The
    // mock runs the callback against itself, so the assertions below are
    // unchanged by the wrapping.
    prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));
    const notifications = { notify: jest.fn(), notifyMany: jest.fn() } as any;
    const service = new ParticipantService(
      prisma,
      {} as any,
      { emitTournamentUpdated: jest.fn() } as any,
      notifications,
    );

    await service.forfeitParticipant('t1', 'x', {
      id: 'creator',
      email: null,
      username: 'c',
      roles: ['ORGANIZER'],
    } as any);

    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'x',
        type: NotificationType.PARTICIPANT_FORFEITED,
      }),
    );
  });
});
