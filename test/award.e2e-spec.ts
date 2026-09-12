import 'reflect-metadata';
import sharp from 'sharp';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AwardKind, NotificationType, Role } from '@prisma/client';
import { RolesGuard } from '../src/guards/roles.guard';
import { JwtAuthGuard } from '../src/guards/jwt-auth.guard';
import { ROLES_KEY } from '../src/guards/decorators/roles.decorator';
import { AwardService } from '../src/award/award.service';
import {
  AwardCatalogController,
  AwardGrantController,
  ShowcaseController,
} from '../src/award/award.controller';
import { ImagesService } from '../src/images/images.service';

/**
 * Awards are admin-exclusive, and a showcase is the owner's own business. Both
 * halves are asserted here, plus the rules the database cannot express: pins
 * are medals, the displayed one is a plaque, one medal fills one slot.
 */

const guardsOf = (target: object): unknown[] =>
  (Reflect.getMetadata('__guards__', target) as unknown[]) ?? [];
const rolesOf = (target: object): Role[] =>
  (Reflect.getMetadata(ROLES_KEY, target) as Role[]) ?? [];

describe('award routes are admin-only', () => {
  it.each([
    ['catalog', AwardCatalogController],
    ['grants', AwardGrantController],
  ])('the %s controller requires JWT + ADMIN', (_, ctrl) => {
    expect(guardsOf(ctrl)).toEqual(expect.arrayContaining([JwtAuthGuard, RolesGuard]));
    expect(rolesOf(ctrl)).toEqual([Role.ADMIN]);
  });

  it('the showcase is any signed-in user, not admin-gated', () => {
    // Everyone arranges their own showcase; the service confines them to
    // their own grants.
    expect(guardsOf(ShowcaseController)).toContain(JwtAuthGuard);
    expect(rolesOf(ShowcaseController)).toEqual([]);
  });
});

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Grant = { id: string; userId: string; awardId: string; kind: AwardKind };

function build(grants: Grant[] = [], extra: Record<string, unknown> = {}) {
  const prisma: any = {
    user: { findUnique: jest.fn() },
    award: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findMany: jest.fn(),
    },
    userAward: {
      findMany: jest.fn(async ({ where }: any) =>
        grants
          .filter((g) => (where.id?.in ? where.id.in.includes(g.id) : true) && g.userId === where.userId)
          .map((g) => ({
            id: g.id,
            awardId: g.awardId,
            award: { kind: g.kind, name: 'x', description: null, imageUrl: '/u' },
            awardedAt: new Date(),
            note: null,
            pinSlot: null,
            displayed: false,
          })),
      ),
      findUnique: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
      update: jest.fn((args: unknown) => ({ op: 'update', args })),
      updateMany: jest.fn((args: unknown) => ({ op: 'updateMany', args })),
    },
    $transaction: jest.fn(async (ops: unknown[]) => ops),
    ...extra,
  };
  const images = { processAndSave: jest.fn(async () => '/uploads/medals/a.webp'), deleteFile: jest.fn() };
  const notifications = { notify: jest.fn() };
  const svc = new AwardService(prisma, images as any, notifications as any);
  return { svc, prisma, images, notifications };
}

describe('giving awards', () => {
  const award = { id: uuid(1), name: 'Champion', kind: AwardKind.MEDAL, archivedAt: null, description: null };

  it('refuses a guest, whose account the cleanup job would delete', async () => {
    const { svc, prisma } = build();
    prisma.user.findUnique.mockResolvedValue({ id: ME, isGuest: true });
    await expect(svc.grant(ME, { awardId: award.id }, OTHER)).rejects.toMatchObject({
      response: { code: 'GUEST_CANNOT_RECEIVE_AWARDS' },
    });
  });

  it('refuses an archived award', async () => {
    const { svc, prisma } = build();
    prisma.user.findUnique.mockResolvedValue({ id: ME, isGuest: false });
    prisma.award.findUnique.mockResolvedValue({ ...award, archivedAt: new Date() });
    await expect(svc.grant(ME, { awardId: award.id }, OTHER)).rejects.toMatchObject({
      response: { code: 'AWARD_ARCHIVED' },
    });
  });

  it('records who gave it and notifies the recipient', async () => {
    const { svc, prisma, notifications } = build();
    prisma.user.findUnique.mockResolvedValue({ id: ME, isGuest: false });
    prisma.award.findUnique.mockResolvedValue(award);
    prisma.userAward.create.mockResolvedValue({
      id: uuid(9), awardId: award.id, awardedAt: new Date(), note: 'Won it',
      pinSlot: null, displayed: false,
      award: { name: 'Champion', description: null, kind: AwardKind.MEDAL, imageUrl: '/u' },
    });

    await svc.grant(ME, { awardId: award.id, note: 'Won it' }, OTHER);

    expect(prisma.userAward.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: ME, awardedById: OTHER, note: 'Won it' }),
      }),
    );
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: ME, type: NotificationType.AWARD_RECEIVED }),
    );
  });

  it('moves the pin to a remaining grant when the pinned repeat is revoked', async () => {
    // Champion x2, grant A pinned in slot 1. Revoking A must leave Champion in
    // slot 1 via grant B, not drop it from the showcase.
    const { svc, prisma } = build();
    prisma.userAward.findUnique.mockResolvedValue({
      id: uuid(21), userId: ME, awardId: award.id, pinSlot: 1, displayed: false,
    });
    prisma.userAward.findFirst = jest.fn().mockResolvedValue({ id: uuid(22), userId: ME, awardId: award.id });
    prisma.userAward.delete = jest.fn((args: unknown) => ({ op: 'delete', args }));

    await svc.revoke(ME, uuid(21));

    const ops = prisma.$transaction.mock.calls[0][0] as Array<{ op: string; args: any }>;
    expect(ops[0]).toMatchObject({ op: 'delete', args: { where: { id: uuid(21) } } });
    expect(ops[1]).toMatchObject({
      op: 'update',
      args: { where: { id: uuid(22) }, data: { pinSlot: 1, displayed: false } },
    });
  });

  it('will not delete an award people hold — archive instead', async () => {
    const { svc, prisma } = build();
    prisma.award.findUnique.mockResolvedValue(award);
    prisma.userAward.count.mockResolvedValue(3);
    await expect(svc.remove(award.id)).rejects.toMatchObject({
      response: { code: 'AWARD_IN_USE', count: 3 },
    });
    expect(prisma.award.delete).not.toHaveBeenCalled();
  });
});

describe('the showcase', () => {
  const medalA = { id: uuid(11), userId: ME, awardId: uuid(101), kind: AwardKind.MEDAL };
  const medalA2 = { id: uuid(12), userId: ME, awardId: uuid(101), kind: AwardKind.MEDAL };
  const medalB = { id: uuid(13), userId: ME, awardId: uuid(102), kind: AwardKind.MEDAL };
  const medalC = { id: uuid(14), userId: ME, awardId: uuid(103), kind: AwardKind.MEDAL };
  const medalD = { id: uuid(15), userId: ME, awardId: uuid(104), kind: AwardKind.MEDAL };
  const plaque = { id: uuid(16), userId: ME, awardId: uuid(105), kind: AwardKind.PLAQUE };
  const theirs = { id: uuid(17), userId: OTHER, awardId: uuid(106), kind: AwardKind.MEDAL };
  const mine = [medalA, medalA2, medalB, medalC, medalD, plaque, theirs];

  it('rejects a fourth pin', async () => {
    const { svc } = build(mine);
    await expect(
      svc.setShowcase(ME, { pinnedMedals: [medalA.id, medalB.id, medalC.id, medalD.id], plaque: null }),
    ).rejects.toThrow(/at most 3/i);
  });

  it('rejects a plaque in a pin slot', async () => {
    const { svc } = build(mine);
    await expect(
      svc.setShowcase(ME, { pinnedMedals: [plaque.id], plaque: null }),
    ).rejects.toThrow(/only medals/i);
  });

  it('rejects a medal as the displayed plaque', async () => {
    const { svc } = build(mine);
    await expect(
      svc.setShowcase(ME, { pinnedMedals: [], plaque: medalA.id }),
    ).rejects.toThrow(/only a plaque/i);
  });

  it("rejects somebody else's grant", async () => {
    const { svc } = build(mine);
    await expect(
      svc.setShowcase(ME, { pinnedMedals: [theirs.id], plaque: null }),
    ).rejects.toThrow(/not yours/i);
  });

  it('rejects the same medal twice, even as two separate grants', async () => {
    // "Champion" won twice is one medal with a x2 badge, not two slots.
    const { svc } = build(mine);
    await expect(
      svc.setShowcase(ME, { pinnedMedals: [medalA.id, medalA2.id], plaque: null }),
    ).rejects.toThrow(/cannot be pinned twice/i);
  });

  it('clears the old showcase before setting the new one, atomically', async () => {
    const { svc, prisma } = build(mine);
    await svc.setShowcase(ME, { pinnedMedals: [medalB.id, medalA.id], plaque: plaque.id });

    const ops = prisma.$transaction.mock.calls[0][0] as Array<{ op: string; args: any }>;
    // First the clear, so neither unique index sees two claimants...
    expect(ops[0]).toMatchObject({
      op: 'updateMany',
      args: { where: { userId: ME }, data: { pinSlot: null, displayed: false } },
    });
    // ...then the pins in slot order, then the plaque.
    expect(ops[1]).toMatchObject({ args: { where: { id: medalB.id }, data: { pinSlot: 1 } } });
    expect(ops[2]).toMatchObject({ args: { where: { id: medalA.id }, data: { pinSlot: 2 } } });
    expect(ops[3]).toMatchObject({ args: { where: { id: plaque.id }, data: { displayed: true } } });
  });
});

describe('award artwork', () => {
  let root: string;
  let images: ImagesService;

  beforeAll(async () => {
    root = join(tmpdir(), `joust-award-art-${Date.now()}`);
    await fs.mkdir(join(root, 'medals'), { recursive: true });
    await fs.mkdir(join(root, 'plaques'), { recursive: true });
    images = new ImagesService({} as any);
    (images as any).uploadRoot = root;
  });
  afterAll(async () => fs.rm(root, { recursive: true, force: true }));

  const file = (buffer: Buffer) => ({ buffer } as Express.Multer.File);

  it('contains a non-square medal on a transparent 512x512 canvas — never crops it', async () => {
    // A tall 300x600 shape: cropping it to a square would cut the top and bottom off.
    const tall = await sharp({
      create: { width: 300, height: 600, channels: 4, background: { r: 200, g: 160, b: 40, alpha: 1 } },
    }).png().toBuffer();

    const url = await images.processAndSave(file(tall), 'medals');
    const out = sharp(join(root, url.replace('/uploads/', '')));
    const meta = await out.metadata();
    expect([meta.width, meta.height]).toEqual([512, 512]);
    expect(meta.hasAlpha).toBe(true);

    // The left edge is padding, so it must be fully transparent; the middle
    // column is the medal, so the whole height of the shape survived.
    const { data, info } = await out.raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
    expect(alphaAt(2, 256)).toBe(0);
    expect(alphaAt(256, 4)).toBeGreaterThan(200);
    expect(alphaAt(256, 507)).toBeGreaterThan(200);
  });

  it('produces an exact 1200x300 plaque', async () => {
    const wide = await sharp({
      create: { width: 1600, height: 900, channels: 3, background: { r: 30, g: 30, b: 30 } },
    }).png().toBuffer();
    const url = await images.processAndSave(file(wide), 'plaques');
    const meta = await sharp(join(root, url.replace('/uploads/', ''))).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 300]);
  });
});
