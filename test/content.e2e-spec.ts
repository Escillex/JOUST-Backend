import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  BuildStatus,
  BuildVisibility,
  Prisma,
  TournamentStatus,
} from '@prisma/client';
import { BuildService, assertBuildsReady } from '../src/content/build.service';
import { GalleryService } from '../src/content/gallery.service';
import {
  ModerationService,
  REMOVAL_HOLD_DAYS,
} from '../src/content/moderation.service';
import { ReviewBuildDto, SubmitBuildDto } from '../src/content/dto/content.dto';

/**
 * Tournament builds, galleries and moderation (todo.md obj. 4.3). The rules
 * that matter: who sees a build and when, what locks, what blocks a start, who
 * may post to a gallery, and that only admins remove — reversibly for 30 days.
 */
const T = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    id: 't1',
    name: 'Winter Open',
    status: TournamentStatus.OPEN,
    buildsRequired: false,
    buildVisibility: BuildVisibility.AFTER_COMPLETION,
    buildsLockAtStart: true,
    ...over,
  }) as any;

describe('who sees a build', () => {
  const live = (status: BuildStatus) => ({ status, removedAt: null });
  it.each([
    [
      'public, optional',
      T({ buildVisibility: 'PUBLIC' }),
      live('PENDING'),
      true,
    ],
    [
      'public, required, unapproved',
      T({ buildVisibility: 'PUBLIC', buildsRequired: true }),
      live('PENDING'),
      false,
    ],
    [
      'public, required, approved',
      T({ buildVisibility: 'PUBLIC', buildsRequired: true }),
      live('APPROVED'),
      true,
    ],
    [
      'after completion, still running',
      T({ status: 'ONGOING' }),
      live('APPROVED'),
      false,
    ],
    [
      'after completion, finished',
      T({ status: 'COMPLETED' }),
      live('APPROVED'),
      true,
    ],
    [
      'staff only',
      T({ buildVisibility: 'STAFF_ONLY', status: 'COMPLETED' }),
      live('APPROVED'),
      false,
    ],
    [
      'removed by an admin',
      T({ buildVisibility: 'PUBLIC' }),
      { status: 'APPROVED', removedAt: new Date() },
      false,
    ],
  ])('%s -> %s', (_, t, b, expected) => {
    expect(BuildService.visibleToPublic(t, b as any)).toBe(expected);
  });
});

describe('submitting a build', () => {
  const make = (
    t: any,
    entry: any = { status: 'ACTIVE' },
    existing: any = null,
  ) => {
    const prisma: any = {
      tournament: { findUnique: jest.fn(async () => t) },
      tournamentParticipant: { findFirst: jest.fn(async () => entry) },
      tournamentBuild: {
        findFirst: jest.fn(async () => existing),
        create: jest.fn(async ({ data }: any) => data),
        update: jest.fn(async ({ data }: any) => data),
      },
    };
    const images = {
      processAndSave: jest.fn(async () => '/uploads/builds/x.webp'),
      deleteFile: jest.fn(),
    };
    return {
      svc: new BuildService(
        prisma,
        images as any,
        { notify: jest.fn() } as any,
      ),
      prisma,
    };
  };

  it('is refused once the tournament has started and builds lock at start', async () => {
    const { svc } = make(T({ status: 'ONGOING' }));
    await expect(
      svc.submit('t1', 'u1', { kind: 'TEXT', text: 'x' } as any),
    ).rejects.toMatchObject({ response: { code: 'BUILDS_LOCKED' } });
  });

  it('is allowed mid-event when the tournament does not lock', async () => {
    const { svc } = make(T({ status: 'ONGOING', buildsLockAtStart: false }));
    await expect(
      svc.submit('t1', 'u1', { kind: 'TEXT', text: '4x Pikachu' } as any),
    ).resolves.toBeDefined();
  });

  it('is refused to a forfeited entrant', async () => {
    const { svc } = make(T(), { status: 'FORFEITED' });
    await expect(
      svc.submit('t1', 'u1', { kind: 'TEXT', text: 'x' } as any),
    ).rejects.toThrow(/active entrant/i);
  });

  it('sends an edited build back to review — an approval covers what was reviewed', async () => {
    const { svc, prisma } = make(T(), undefined, {
      id: 'b1',
      status: 'APPROVED',
      imageUrl: null,
    });
    await svc.submit('t1', 'u1', {
      kind: 'LINK',
      url: 'https://decks.example/1',
    } as any);
    expect(prisma.tournamentBuild.update.mock.calls[0][0].data).toMatchObject({
      status: 'PENDING',
      reviewedById: null,
    });
  });
});

describe('validation', () => {
  it('only accepts https links — no http, no javascript:', async () => {
    const check = async (url: string) =>
      (await validate(plainToInstance(SubmitBuildDto, { kind: 'LINK', url })))
        .length === 0;
    expect(await check('https://limitlesstcg.com/decks/1')).toBe(true);
    expect(await check('http://example.com')).toBe(false);
    expect(await check('javascript:alert(1)')).toBe(false);
  });

  it('requires a reason to reject', async () => {
    expect(
      await validate(plainToInstance(ReviewBuildDto, { decision: 'REJECTED' })),
    ).not.toHaveLength(0);
    expect(
      await validate(plainToInstance(ReviewBuildDto, { decision: 'APPROVED' })),
    ).toHaveLength(0);
  });
});

describe('mandatory builds block the start', () => {
  const prisma = (builds: { userId: string; status: string }[]) =>
    ({
      tournamentParticipant: {
        findMany: jest.fn(async () => [
          { userId: 'a', user: { username: 'ann', displayName: 'Ann' } },
          { userId: 'b', user: { username: 'bob', displayName: 'Bob' } },
          { userId: 'c', user: { username: 'cy', displayName: 'Cy' } },
        ]),
      },
      tournamentBuild: { findMany: jest.fn(async () => builds) },
    }) as any;

  it('names who is missing and who is waiting on review', async () => {
    await expect(
      assertBuildsReady(
        prisma([
          { userId: 'a', status: 'APPROVED' },
          { userId: 'b', status: 'PENDING' },
        ]),
        't1',
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'BUILDS_INCOMPLETE',
        missing: ['Cy'],
        pending: ['Bob'],
      },
    });
  });

  it('lets the tournament start once every entrant is approved', async () => {
    const all = ['a', 'b', 'c'].map((userId) => ({
      userId,
      status: 'APPROVED',
    }));
    await expect(assertBuildsReady(prisma(all), 't1')).resolves.toBeUndefined();
  });

  it('exempts guests, who have no account to submit from', async () => {
    const p = prisma([]);
    await assertBuildsReady(p, 't1').catch(() => undefined);
    expect(p.tournamentParticipant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ user: { isGuest: false } }),
      }),
    );
  });

  it("hides another player's review note from the public list", async () => {
    const p: any = {
      tournament: {
        findUnique: jest.fn(async () =>
          T({ status: 'COMPLETED', buildVisibility: 'AFTER_COMPLETION' }),
        ),
      },
      tournamentBuild: {
        findMany: jest.fn(async () => [
          {
            id: 'b1',
            userId: 'x',
            status: 'REJECTED',
            reviewNote: 'illegal card',
            reviewedById: 'org',
            removedAt: null,
            user: {},
          },
        ]),
      },
      tournamentOrganizer: { findUnique: jest.fn(async () => null) },
    };
    const svc = new BuildService(p, {} as any, {} as any);
    const res = await svc.list('t1', {
      id: 'someone',
      roles: ['PLAYER'],
    } as any);
    expect(res.builds[0]).toMatchObject({
      id: 'b1',
      reviewNote: null,
      reviewedById: null,
    });
  });

  it('settings that define the event cannot change after it starts; visibility can', async () => {
    const p: any = {
      tournament: {
        findUnique: jest.fn(async () => T({ status: 'ONGOING' })),
        update: jest.fn(async () => ({})),
      },
    };
    const svc = new BuildService(p, {} as any, {} as any);
    await expect(
      svc.updateSettings('t1', { buildsRequired: true }),
    ).rejects.toThrow(/before the tournament starts/);
    await expect(
      svc.updateSettings('t1', { buildVisibility: 'PUBLIC' as any }),
    ).resolves.toBeDefined();
  });
});

describe('gallery eligibility', () => {
  it('requires a COMPLETED tournament finished as an ACTIVE (not forfeited) entrant', async () => {
    const prisma: any = {
      tournamentParticipant: { findFirst: jest.fn(async () => null) },
    };
    const svc = new GalleryService(prisma, {} as any);
    expect(await svc.isEligible('u1')).toBe(false);
    expect(
      prisma.tournamentParticipant.findFirst.mock.calls[0][0].where,
    ).toMatchObject({
      userId: 'u1',
      status: 'ACTIVE',
      tournament: { status: 'COMPLETED' },
    });
    await expect(svc.upsert('u1', 'g1', undefined)).rejects.toMatchObject({
      response: { code: 'GALLERY_NOT_ELIGIBLE' },
    });
  });
});

describe('moderation', () => {
  const make = (row: any) => {
    const prisma: any = {
      galleryImage: {
        findUnique: jest.fn(async () => row),
        update: jest.fn(async () => ({})),
        findMany: jest.fn(async () => []),
        deleteMany: jest.fn(async () => ({})),
      },
      tournamentBuild: {
        findMany: jest.fn(async () => []),
        deleteMany: jest.fn(),
      },
      contentReport: {
        create: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      $transaction: jest.fn(async (ops: unknown[]) => ops),
    };
    const notifications = { notify: jest.fn() };
    const audit = { record: jest.fn() };
    const images = { deleteFile: jest.fn() };
    return {
      svc: new ModerationService(
        prisma,
        images as any,
        notifications as any,
        audit as any,
      ),
      prisma,
      notifications,
      audit,
      images,
    };
  };
  const img = {
    id: 'g1',
    userId: 'owner',
    removedAt: null,
    user: { username: 'o', displayName: 'Owner' },
    game: { name: 'Chess' },
  };
  const player = { id: 'p1', roles: ['PLAYER'] } as any;
  const organizer = { id: 'o1', roles: ['PLAYER', 'ORGANIZER'] } as any;

  it('refuses a report on your own upload', async () => {
    const { svc } = make(img);
    await expect(
      svc.report(
        { id: 'owner', roles: [] } as any,
        { targetType: 'GALLERY_IMAGE', targetId: 'g1', reason: 'SPAM' } as any,
      ),
    ).rejects.toThrow(/own upload/i);
  });

  it('turns a duplicate report into a clear 409', async () => {
    const { svc, prisma } = make(img);
    prisma.contentReport.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );
    await expect(
      svc.report(player, {
        targetType: 'GALLERY_IMAGE',
        targetId: 'g1',
        reason: 'SPAM',
      } as any),
    ).rejects.toMatchObject({ response: { code: 'ALREADY_REPORTED' } });
  });

  it("flags an organizer's report as a staff removal request, and audits it", async () => {
    const { svc, prisma, audit } = make(img);
    await svc.report(organizer, {
      targetType: 'GALLERY_IMAGE',
      targetId: 'g1',
      reason: 'OFFENSIVE',
    } as any);
    expect(prisma.contentReport.create.mock.calls[0][0].data).toMatchObject({
      fromStaff: true,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'moderation.request_removal' }),
    );
  });

  it("does not audit a player's report — that is not an organizer action", async () => {
    const { svc, audit } = make(img);
    await svc.report(player, {
      targetType: 'GALLERY_IMAGE',
      targetId: 'g1',
      reason: 'SPAM',
    } as any);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('removal hides the item, resolves its reports and tells the owner why', async () => {
    const { svc, prisma, notifications } = make(img);
    await svc.remove({ id: 'admin', roles: ['ADMIN'] } as any, {
      targetType: 'GALLERY_IMAGE',
      targetId: 'g1',
      reason: 'Not a game photo',
    });
    expect(prisma.galleryImage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          removedAt: expect.any(Date),
          removalReason: 'Not a game photo',
        }),
      }),
    );
    expect(prisma.contentReport.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'RESOLVED' }),
      }),
    );
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner', body: 'Not a game photo' }),
    );
  });

  it('refuses a restore when the owner has since uploaded a replacement', async () => {
    const { svc, prisma } = make({ ...img, removedAt: new Date() });
    prisma.galleryImage.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );
    await expect(
      svc.restore({ targetType: 'GALLERY_IMAGE', targetId: 'g1' }),
    ).rejects.toMatchObject({ response: { code: 'SLOT_TAKEN' } });
  });

  it(`purges only items past their ${REMOVAL_HOLD_DAYS}-day hold`, async () => {
    const { svc, prisma, images } = make(img);
    prisma.galleryImage.findMany.mockResolvedValue([
      { id: 'old', imageUrl: '/uploads/gallery/old.webp' },
    ]);
    const now = new Date('2026-10-20T00:00:00Z');
    await svc.purgeExpired(now);
    const cutoff: Date =
      prisma.galleryImage.findMany.mock.calls[0][0].where.removedAt.lt;
    expect(now.getTime() - cutoff.getTime()).toBe(
      REMOVAL_HOLD_DAYS * 24 * 3600 * 1000,
    );
    expect(images.deleteFile).toHaveBeenCalledWith('/uploads/gallery/old.webp');
  });
});
