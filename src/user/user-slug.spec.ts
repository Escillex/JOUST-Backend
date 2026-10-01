import { generateUniqueUserSlug, slugifyUsername } from './user-slug.util';

/**
 * A user's public handle. It is a unique column and a URL segment at once, so a
 * slug that is empty, over-long, or equal to a static route under `/profile`
 * either breaks the insert or shadows a real person's page.
 */

describe('slugifyUsername', () => {
  it('lowercases and collapses separators', () => {
    expect(slugifyUsername('Mira Calder')).toBe('mira-calder');
    expect(slugifyUsername('MIRA__CALDER')).toBe('mira-calder');
    expect(slugifyUsername("O'Brien-Smith")).toBe('o-brien-smith');
  });

  it('trims leading and trailing separators', () => {
    expect(slugifyUsername('  Mira  ')).toBe('mira');
    expect(slugifyUsername('---mira---')).toBe('mira');
    expect(slugifyUsername('!!!')).toBe('player');
  });

  it('keeps digits', () => {
    expect(slugifyUsername('player2481')).toBe('player2481');
    expect(slugifyUsername('Guest 42')).toBe('guest-42');
  });

  it('never returns an empty slug', () => {
    for (const input of ['', '   ', '###', null, undefined]) {
      expect(slugifyUsername(input)).toBe('player');
    }
  });

  it('caps the length at 40 characters', () => {
    const slug = slugifyUsername('a'.repeat(120));
    expect(slug).toHaveLength(40);
  });

  it('can leave a trailing hyphen when the cap lands on a separator', () => {
    // Documented, not endorsed: the trim runs BEFORE the 40-char slice, so a
    // name whose 40th character is a separator keeps it. The slug is still
    // unique and still routes, so this is cosmetic — see
    // docs/dead-code-audit.md §10.3. Pinned so a future tidy-up is deliberate.
    const slug = slugifyUsername('a'.repeat(39) + ' ' + 'b'.repeat(20));
    expect(slug).toBe('a'.repeat(39) + '-');
  });

  it('gets out of the way of the static profile routes', () => {
    // /profile/edit exists; `me` is reserved by convention.
    expect(slugifyUsername('edit')).toBe('edit-1');
    expect(slugifyUsername('Me')).toBe('me-1');
  });

  it('leaves ordinary names alone, including "admin"', () => {
    // The reserved list is deliberately minimal — an admin gets a clean handle.
    expect(slugifyUsername('admin')).toBe('admin');
    expect(slugifyUsername('editor')).toBe('editor');
    expect(slugifyUsername('member')).toBe('member');
  });
});

describe('generateUniqueUserSlug', () => {
  /** A lookup over a fixed set of taken slugs. */
  const lookup = (taken: Record<string, string>) => ({
    user: {
      findUnique: jest.fn(async ({ where }: any) =>
        taken[where.slug] ? { id: taken[where.slug] } : null,
      ),
    },
  });

  it('returns the base slug when nothing holds it', async () => {
    await expect(
      generateUniqueUserSlug(lookup({}), 'Mira Calder'),
    ).resolves.toBe('mira-calder');
  });

  it('appends -2, then -3, past the slugs already taken', async () => {
    const client = lookup({ 'mira-calder': 'a', 'mira-calder-2': 'b' });
    await expect(generateUniqueUserSlug(client, 'Mira Calder')).resolves.toBe(
      'mira-calder-3',
    );
  });

  it('lets a user keep its own slug when re-deriving on update', async () => {
    // Without ignoreUserId, re-saving a user would collide with itself and
    // silently drift to '-2'.
    const client = lookup({ 'mira-calder': 'user-1' });
    await expect(
      generateUniqueUserSlug(client, 'Mira Calder', 'user-1'),
    ).resolves.toBe('mira-calder');
  });

  it('still steps past a slug that belongs to somebody else', async () => {
    const client = lookup({ 'mira-calder': 'user-9' });
    await expect(
      generateUniqueUserSlug(client, 'Mira Calder', 'user-1'),
    ).resolves.toBe('mira-calder-2');
  });

  it('keeps suffixed slugs inside the 40-character budget', async () => {
    const long = 'a'.repeat(60);
    const base = slugifyUsername(long);
    const client = lookup({ [base]: 'a' });
    const slug = await generateUniqueUserSlug(client, long);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-2')).toBe(true);
  });

  it('falls back to the "player" base for a nameless account', async () => {
    const client = lookup({ player: 'a' });
    await expect(generateUniqueUserSlug(client, null)).resolves.toBe(
      'player-2',
    );
  });

  it('stops querying as soon as a free slug is found', async () => {
    const client = lookup({ 'mira-calder': 'a' });
    await generateUniqueUserSlug(client, 'Mira Calder');
    expect(client.user.findUnique).toHaveBeenCalledTimes(2);
  });
});
