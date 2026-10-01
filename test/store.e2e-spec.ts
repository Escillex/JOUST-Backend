import { NotFoundException } from '@nestjs/common';
import { StoreController } from '../src/store/store.controller';
import { JwtAuthGuard } from '../src/guards/jwt-auth.guard';
import { RolesGuard } from '../src/guards/roles.guard';
import { ROLES_KEY } from '../src/guards/decorators/roles.decorator';
import { Role } from '@prisma/client';

// The service touches the filesystem in its constructor and through sharp, so
// both are stubbed before it is imported.
jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
  mkdirSync: jest.fn(),
  unlinkSync: jest.fn(),
}));
jest.mock('sharp', () => {
  const chain = {
    resize: jest.fn(() => chain),
    webp: jest.fn(() => chain),
    toFile: jest.fn(async () => undefined),
  };
  return { __esModule: true, default: jest.fn(() => chain) };
});

import * as fs from 'fs';
import { StoreService } from '../src/store/store.service';
import type { PrismaService } from 'prisma/prisma.service';

/**
 * The storefront on the landing page. It had no test of any kind, and it is the
 * one catalog with a *visibility* rule — an admin can stage a product before it
 * goes live — so the thing worth pinning is which read honours that rule.
 */

const visible = {
  id: 'p1',
  name: 'Sleeves',
  sortOrder: 0,
  isVisible: true,
  imageUrl: '/uploads/assets/a.webp',
};
const hidden = {
  id: 'p2',
  name: 'Unannounced',
  sortOrder: 1,
  isVisible: false,
  imageUrl: null,
};

function harness(rows: any[] = [visible, hidden]) {
  const store = new Map(rows.map((r) => [r.id, { ...r }]));
  const prisma = {
    storeProduct: {
      findMany: jest.fn(async ({ where }: any = {}) =>
        [...store.values()]
          .filter((p) =>
            where?.isVisible === undefined
              ? true
              : p.isVisible === where.isVisible,
          )
          .sort((a, b) => a.sortOrder - b.sortOrder),
      ),
      findUnique: jest.fn(
        async ({ where }: any) => store.get(where.id) ?? null,
      ),
      aggregate: jest.fn(async () => ({
        _max: {
          sortOrder: store.size
            ? Math.max(...[...store.values()].map((p) => p.sortOrder))
            : null,
        },
      })),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `p${store.size + 1}`, ...data };
        store.set(row.id, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = { ...store.get(where.id), ...data };
        store.set(where.id, row);
        return row;
      }),
      delete: jest.fn(async ({ where }: any) => {
        const row = store.get(where.id);
        store.delete(where.id);
        return row;
      }),
    },
  };
  return {
    svc: new StoreService(prisma as unknown as PrismaService),
    prisma,
    store,
  };
}

beforeEach(() => jest.clearAllMocks());

describe('store — visibility', () => {
  it('the public list serves only visible products', async () => {
    const { svc } = harness();
    const rows = await svc.findVisible();
    expect(rows.map((p: any) => p.id)).toEqual(['p1']);
  });

  it('the admin list serves hidden products too', async () => {
    const { svc } = harness();
    const rows = await svc.findAll();
    expect(rows.map((p: any) => p.id)).toEqual(['p1', 'p2']);
  });

  it('both lists order by sortOrder, so the landing page is arrangeable', async () => {
    const { svc, prisma } = harness();
    await svc.findVisible();
    await svc.findAll();
    for (const call of prisma.storeProduct.findMany.mock.calls) {
      expect(call[0].orderBy).toEqual({ sortOrder: 'asc' });
    }
  });

  it('findOne does NOT apply the visibility rule — a hidden product is readable by id', async () => {
    // Documented, not endorsed. GET /store/:id is unguarded (only-GET-reads-are-
    // unguarded), so anyone holding an id can read a product staged for later.
    // Ids are uuids and nothing links to an unreleased one, so this leaks a name
    // and price rather than anything sensitive — recorded in
    // docs/dead-code-audit.md so the decision to keep it is deliberate.
    const { svc } = harness();
    await expect(svc.findOne('p2')).resolves.toMatchObject({
      id: 'p2',
      isVisible: false,
    });
  });
});

describe('store — the admin routes are ADMIN-only', () => {
  const proto = StoreController.prototype as unknown as Record<string, unknown>;
  const guardsOf = (h: unknown) =>
    (Reflect.getMetadata('__guards__', h as object) as unknown[]) ?? [];
  const rolesOf = (h: unknown) =>
    (Reflect.getMetadata(ROLES_KEY, h as object) as Role[]) ?? [];

  it.each([
    'findAll',
    'create',
    'update',
    'uploadImage',
    'removeImage',
    'remove',
  ])('%s requires an authenticated ADMIN', (name) => {
    expect(guardsOf(proto[name])).toEqual(
      expect.arrayContaining([JwtAuthGuard, RolesGuard]),
    );
    expect(rolesOf(proto[name])).toContain(Role.ADMIN);
  });

  it.each(['findVisible', 'findOne'])('%s stays public', (name) => {
    expect(guardsOf(proto[name])).toHaveLength(0);
  });
});

describe('store — creating a product', () => {
  it('appends to the end of the list by default', async () => {
    const { svc } = harness();
    const created: any = await svc.create({ name: 'Mat' } as any);
    expect(created.sortOrder).toBe(2); // max existing (1) + 1
  });

  it('starts at 0 on an empty catalog', async () => {
    const { svc } = harness([]);
    const created: any = await svc.create({ name: 'First' } as any);
    expect(created.sortOrder).toBe(0);
  });

  it('honours an explicit position', async () => {
    const { svc } = harness();
    const created: any = await svc.create({ name: 'Mat', sortOrder: 0 } as any);
    expect(created.sortOrder).toBe(0);
  });
});

describe('store — missing products', () => {
  it.each([
    ['findOne', (s: StoreService) => s.findOne('nope')],
    ['update', (s: StoreService) => s.update('nope', { name: 'x' } as any)],
    ['removeImage', (s: StoreService) => s.removeImage('nope')],
    ['remove', (s: StoreService) => s.remove('nope')],
  ])('%s 404s rather than writing to nothing', async (_name, call) => {
    const { svc, prisma } = harness();
    await expect(call(svc)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.storeProduct.update).not.toHaveBeenCalled();
    expect(prisma.storeProduct.delete).not.toHaveBeenCalled();
  });
});

describe('store — image lifecycle', () => {
  const file = { buffer: Buffer.from('x') } as Express.Multer.File;

  it('replacing an image removes the old file first, so uploads do not accumulate', async () => {
    const { svc } = harness();
    await svc.uploadImage('p1', file);
    expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
    expect((fs.unlinkSync as jest.Mock).mock.calls[0][0]).toContain('a.webp');
  });

  it('stores a web-servable path, not a disk path', async () => {
    const { svc, store } = harness();
    await svc.uploadImage('p1', file);
    expect(store.get('p1')!.imageUrl).toMatch(
      /^\/uploads\/assets\/[\w-]+\.webp$/,
    );
  });

  it('does not try to unlink when the product had no image', async () => {
    const { svc } = harness();
    await svc.uploadImage('p2', file);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it('removing the image clears the column as well as the file', async () => {
    const { svc, store } = harness();
    await svc.removeImage('p1');
    expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
    expect(store.get('p1')!.imageUrl).toBeNull();
  });

  it('deleting a product takes its image with it', async () => {
    const { svc, store } = harness();
    await svc.remove('p1');
    expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
    expect(store.has('p1')).toBe(false);
  });

  it('survives a file that is already gone', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    const { svc } = harness();
    await expect(svc.remove('p1')).resolves.toBeDefined();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it('survives an unlink that throws — a locked file must not fail the delete', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.unlinkSync as jest.Mock).mockImplementation(() => {
      throw new Error('EBUSY');
    });
    const { svc } = harness();
    await expect(svc.remove('p1')).resolves.toBeDefined();
  });
});
