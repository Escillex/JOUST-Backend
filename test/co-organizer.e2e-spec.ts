import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OrganizerService } from '../src/organizer/organizer.service';

const CREATOR = {
  id: 'creator',
  email: null,
  username: 'c',
  roles: ['ORGANIZER'],
} as any;
const COORG = {
  id: 'coorg',
  email: null,
  username: 'x',
  roles: ['ORGANIZER'],
} as any;
const ADMIN = {
  id: 'admin',
  email: null,
  username: 'a',
  roles: ['ADMIN'],
} as any;

const build = (overrides: Record<string, any> = {}) => {
  const prisma = {
    tournament: {
      findUnique: jest.fn().mockResolvedValue({
        id: 't1',
        name: 'Summer Cup',
        createdById: 'creator',
      }),
    },
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'invitee', roles: ['ORGANIZER'] }),
    },
    tournamentOrganizer: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({ id: 'inv1' }),
      update: jest.fn().mockResolvedValue({ id: 'inv1' }),
      delete: jest.fn().mockResolvedValue({}),
    },
    ...overrides,
  } as any;
  const notifications = { notify: jest.fn(), notifyMany: jest.fn() } as any;
  const realtime = { emitTournamentUpdated: jest.fn() } as any;
  return {
    prisma,
    notifications,
    realtime,
    service: new OrganizerService(prisma, notifications, realtime),
  };
};

describe('OrganizerService.invite', () => {
  it('lets the creator invite an organizer and notifies them', async () => {
    const { prisma, notifications, service } = build();
    await service.invite('t1', 'invitee', CREATOR);
    expect(prisma.tournamentOrganizer.upsert).toHaveBeenCalled();
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'invitee',
        type: 'ORGANIZER_INVITED',
      }),
    );
  });

  it('lets an ADMIN invite', async () => {
    const { service } = build();
    await expect(
      service.invite('t1', 'invitee', ADMIN),
    ).resolves.toBeUndefined();
  });

  it('rejects a co-organizer inviting more staff', async () => {
    // Staff must not be able to recruit staff: the authority chain stays
    // traceable to one person.
    const { service } = build();
    await expect(service.invite('t1', 'invitee', COORG)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects a target who does not hold the ORGANIZER role', async () => {
    const { service } = build({
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'invitee', roles: ['PLAYER'] }),
      },
    });
    await expect(service.invite('t1', 'invitee', CREATOR)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects inviting the creator', async () => {
    const { service } = build();
    await expect(service.invite('t1', 'creator', CREATOR)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects inviting someone already ACCEPTED', async () => {
    const { service } = build({
      tournamentOrganizer: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'inv1', status: 'ACCEPTED' }),
        findMany: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    });
    await expect(service.invite('t1', 'invitee', CREATOR)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects inviting someone who already has a pending invitation', async () => {
    const { service } = build({
      tournamentOrganizer: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'inv1', status: 'PENDING' }),
        findMany: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    });
    await expect(service.invite('t1', 'invitee', CREATOR)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('re-invites someone who previously declined', async () => {
    // A decline is not permanent - people change their minds, or were asked at
    // a bad moment.
    const { prisma, service } = build({
      tournamentOrganizer: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'inv1', status: 'DECLINED' }),
        findMany: jest.fn(),
        upsert: jest.fn().mockResolvedValue({ id: 'inv1' }),
        update: jest.fn(),
        delete: jest.fn(),
      },
    });
    await service.invite('t1', 'invitee', CREATOR);
    expect(prisma.tournamentOrganizer.upsert).toHaveBeenCalled();
  });

  it('404s for a tournament that does not exist', async () => {
    const { service } = build({
      tournament: { findUnique: jest.fn().mockResolvedValue(null) },
    });
    await expect(service.invite('nope', 'invitee', CREATOR)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('OrganizerService.respond', () => {
  const buildWithInvite = (invite: any) =>
    build({
      tournamentOrganizer: {
        findUnique: jest.fn().mockResolvedValue(invite),
        findMany: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn(),
      },
    });

  it('accepts the invitee own invitation', async () => {
    const { prisma, service } = buildWithInvite({
      id: 'inv1',
      userId: 'invitee',
      tournamentId: 't1',
      status: 'PENDING',
    });
    await service.respond('inv1', 'invitee', true);
    expect(prisma.tournamentOrganizer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'ACCEPTED' }),
      }),
    );
  });

  it('declines without granting access', async () => {
    const { prisma, service } = buildWithInvite({
      id: 'inv1',
      userId: 'invitee',
      tournamentId: 't1',
      status: 'PENDING',
    });
    await service.respond('inv1', 'invitee', false);
    expect(prisma.tournamentOrganizer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DECLINED' }),
      }),
    );
  });

  it('404s when the invitation is not the caller own - a leaked id is not usable', async () => {
    const { service } = buildWithInvite({
      id: 'inv1',
      userId: 'somebody-else',
      tournamentId: 't1',
      status: 'PENDING',
    });
    await expect(service.respond('inv1', 'invitee', true)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('400s when the invitation was already answered', async () => {
    const { service } = buildWithInvite({
      id: 'inv1',
      userId: 'invitee',
      tournamentId: 't1',
      status: 'ACCEPTED',
    });
    await expect(service.respond('inv1', 'invitee', true)).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('OrganizerService.revoke', () => {
  const buildWithRow = () =>
    build({
      tournamentOrganizer: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'inv1', userId: 'coorg' }),
        findMany: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        delete: jest.fn().mockResolvedValue({}),
      },
    });

  it('lets the creator revoke', async () => {
    const { prisma, service } = buildWithRow();
    await service.revoke('t1', 'coorg', CREATOR);
    expect(prisma.tournamentOrganizer.delete).toHaveBeenCalled();
  });

  it('rejects a co-organizer revoking anybody', async () => {
    const { service } = buildWithRow();
    await expect(service.revoke('t1', 'coorg', COORG)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('404s when there is no such staff row', async () => {
    const { service } = build();
    await expect(service.revoke('t1', 'nobody', CREATOR)).rejects.toThrow(
      NotFoundException,
    );
  });
});
