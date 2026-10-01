import {
  HOME_BLOCK_KEYS,
  HOME_DEFAULTS,
  isHomeBlockKey,
} from './home.defaults';

/**
 * The landing page as it ships. `HomeService` falls back to these for any block
 * whose row is missing, so a database that was never migrated — or a row
 * somebody deleted by hand — must still render a complete page rather than a
 * blank one. `home-blocks.e2e-spec` covers the reads; this pins the fallback
 * itself, which is the thing that has to be right when the reads find nothing.
 */

describe('isHomeBlockKey', () => {
  it.each(HOME_BLOCK_KEYS)('accepts the shipped key %s', (key) => {
    expect(isHomeBlockKey(key)).toBe(true);
  });

  it('rejects anything else, so PATCH /home/blocks/:key cannot invent a block', () => {
    for (const key of [
      '',
      'Hero',
      'HERO',
      'footer',
      '__proto__',
      'constructor',
    ]) {
      expect(isHomeBlockKey(key)).toBe(false);
    }
  });
});

describe('HOME_DEFAULTS', () => {
  it('has an entry for every declared key, and no extras', () => {
    expect(Object.keys(HOME_DEFAULTS).sort()).toEqual(
      [...HOME_BLOCK_KEYS].sort(),
    );
  });

  it('labels each entry with its own key', () => {
    for (const key of HOME_BLOCK_KEYS) {
      expect(HOME_DEFAULTS[key].key).toBe(key);
    }
  });

  it('ships every block visible — a fresh deployment shows a whole page', () => {
    for (const key of HOME_BLOCK_KEYS) {
      expect(HOME_DEFAULTS[key].visible).toBe(true);
    }
  });

  it('gives the blocks a total order with no ties', () => {
    const orders = HOME_BLOCK_KEYS.map((k) => HOME_DEFAULTS[k].order);
    expect(new Set(orders).size).toBe(orders.length);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it('leads with the hero', () => {
    expect(HOME_DEFAULTS.hero.order).toBe(0);
  });

  it('gives the two section blocks the label their component renders', () => {
    expect(HOME_DEFAULTS.shop.content.label).toBe('STORE');
    expect(HOME_DEFAULTS.tournaments.content.label).toBe('TOURNAMENTS');
  });

  it('gives the hero copy and store buttons but no seeded slides', () => {
    const hero = HOME_DEFAULTS.hero.content as any;
    expect(typeof hero.description).toBe('string');
    expect(hero.description.length).toBeGreaterThan(0);
    // Slides are uploaded per deployment; shipping stock images would put
    // somebody else's photos on a new site.
    expect(hero.slides).toEqual([]);
    expect(hero.storeButtons.length).toBeGreaterThan(0);
  });

  it('gives every store button a destination and a renderable icon', () => {
    for (const button of (HOME_DEFAULTS.hero.content as any).storeButtons) {
      expect(button.href).toMatch(/^https?:\/\//);
      expect(button.iconUrl).toMatch(/^\//);
      expect(button.iconScale).toBeGreaterThan(0);
    }
  });

  it('carries no cyberpunk terminology (Core Rule 6)', () => {
    const banned =
      /uplink|pilot|combat|telemetry|injection|arena|callsign|protocol|operative/i;
    expect(banned.test(JSON.stringify(HOME_DEFAULTS))).toBe(false);
  });
});
