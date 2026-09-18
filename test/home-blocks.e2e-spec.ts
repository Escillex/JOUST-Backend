import { BadRequestException } from '@nestjs/common';
import { HomeService } from '../src/home/home.service';
import { HOME_DEFAULTS } from '../src/home/home.defaults';

/**
 * Home page blocks (docs/home-blocks-plan.md). The landing page is the most
 * public surface the platform has, so these pin the two things that matter:
 * it always renders something, and nothing an admin types can turn a section
 * into an attack on every visitor.
 */

function build(rows: any[] = []) {
  const store = new Map<string, any>(rows.map((r) => [r.key, r]));
  const prisma: any = {
    homeBlock: {
      findMany: jest.fn(async () =>
        [...store.values()].sort((a, b) => a.order - b.order),
      ),
      upsert: jest.fn(async ({ where, update, create }: any) => {
        const existing = store.get(where.key);
        const next = existing ? { ...existing, ...update } : { ...create };
        store.set(where.key, next);
        return next;
      }),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return { prisma, svc: new HomeService(prisma), store };
}

describe('home blocks — reads', () => {
  it('falls back to the shipped copy when a block has no row', async () => {
    const { svc } = build([]);
    const { blocks } = await svc.getConfig();
    expect(blocks.map((b) => b.key)).toEqual(['hero', 'shop', 'tournaments']);
    expect(blocks[0].content.description).toBe(
      HOME_DEFAULTS.hero.content.description,
    );
  });

  it('returns the stored blocks in their configured order', async () => {
    const { svc } = build([
      { key: 'hero', order: 2, visible: false, content: { description: 'Hi' } },
      { key: 'shop', order: 0, visible: true, content: { label: 'GEAR' } },
      {
        key: 'tournaments',
        order: 1,
        visible: true,
        content: { label: 'EVENTS' },
      },
    ]);
    const { blocks } = await svc.getConfig();
    expect(blocks.map((b) => b.key)).toEqual(['shop', 'tournaments', 'hero']);
    expect(blocks[2].visible).toBe(false);
    // A stored block keeps its own text but still inherits the fields it never
    // wrote — an old row must not blank the hero's store buttons.
    expect(blocks[2].content.description).toBe('Hi');
    expect(blocks[2].content.storeButtons).toHaveLength(2);
  });
});

describe('home blocks — writes', () => {
  it('stores only the fields a section renders', async () => {
    const { svc, store } = build();
    await svc.updateBlock('hero', {
      content: {
        description: 'Ours now',
        slides: [
          { image: '/uploads/assets/a.webp', title: 'T', photoDesc: 'D' },
        ],
        storeButtons: [
          { text: 'Shop', href: 'https://example.com', color: '#123456' },
        ],
        somethingElse: 'dropped',
      } as any,
    });
    const saved = store.get('hero').content;
    expect(Object.keys(saved).sort()).toEqual([
      'description',
      'slides',
      'storeButtons',
    ]);
    expect(saved.slides[0]).toEqual({
      image: '/uploads/assets/a.webp',
      title: 'T',
      photoDesc: 'D',
    });
  });

  it('refuses a javascript: link, a protocol-relative one, and an imageless slide', async () => {
    const { svc, store } = build();
    await svc.updateBlock('hero', {
      content: {
        storeButtons: [
          { text: 'Bad', href: 'javascript:alert(1)' },
          { text: 'Sneaky', href: '//evil.example.com' },
          { text: 'Fine', href: '/tournaments' },
        ],
        slides: [
          { title: 'No picture' },
          { image: 'https://cdn.example.com/x.jpg' },
        ],
      } as any,
    });
    const saved = store.get('hero').content;
    expect(saved.storeButtons).toHaveLength(1);
    expect(saved.storeButtons[0].href).toBe('/tournaments');
    expect(saved.slides).toHaveLength(1);
    expect(saved.slides[0].image).toBe('https://cdn.example.com/x.jpg');
  });

  it('caps text and falls back to a usable label rather than an empty divider', async () => {
    const { svc, store } = build();
    await svc.updateBlock('hero', {
      content: { description: 'x'.repeat(900) } as any,
    });
    expect((store.get('hero').content.description as string).length).toBe(400);

    await svc.updateBlock('shop', { content: { label: '   ' } as any });
    expect(store.get('shop').content.label).toBe('STORE');
  });

  it('hides a block without touching its content', async () => {
    const { svc, store } = build([
      { key: 'shop', order: 1, visible: true, content: { label: 'GEAR' } },
    ]);
    await svc.updateBlock('shop', { visible: false });
    expect(store.get('shop')).toMatchObject({
      visible: false,
      content: { label: 'GEAR' },
    });
  });

  it('rejects an unknown or repeated section', async () => {
    const { svc } = build();
    await expect(
      svc.updateBlock('footer', { visible: false }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.reorder({ keys: ['hero', 'hero'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.reorder({ keys: ['nope'] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('reorders by position in the list', async () => {
    const { svc } = build();
    const { blocks } = await svc.reorder({
      keys: ['tournaments', 'hero', 'shop'],
    });
    expect(blocks.map((b) => b.key)).toEqual(['tournaments', 'hero', 'shop']);
  });
});
