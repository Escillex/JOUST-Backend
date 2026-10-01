import { flattenGamesPlayed, GAMES_PLAYED_SELECT } from './games-played.helper';

/**
 * "Games I play" is served from three places (`/auth/me`, `PATCH /auth/me`, the
 * public profile) and rendered by one frontend component. The shape is undone
 * here, once, so those three cannot drift — a raw `[{ game: {...} }]` reaching
 * the client renders as empty cards rather than as an error.
 */

const game = (id: string, name: string, iconUrl: string | null = null) => ({
  id,
  name,
  iconUrl,
});

describe('flattenGamesPlayed', () => {
  it('unwraps the join rows', () => {
    expect(
      flattenGamesPlayed([
        { game: game('g1', 'Chess') },
        { game: game('g2', 'Go') },
      ]),
    ).toEqual([game('g1', 'Chess'), game('g2', 'Go')]);
  });

  it('preserves the order it was given', () => {
    // The select orders oldest-first so the list does not reshuffle between
    // requests; the helper must not sort it again.
    const rows = ['c', 'a', 'b'].map((n) => ({
      game: game(n, n.toUpperCase()),
    }));
    expect(flattenGamesPlayed(rows).map((g) => g.id)).toEqual(['c', 'a', 'b']);
  });

  it('keeps a null icon rather than substituting a placeholder', () => {
    expect(
      flattenGamesPlayed([{ game: game('g1', 'Chess', null) }])[0].iconUrl,
    ).toBeNull();
  });

  it('returns an empty array for a user who has declared nothing', () => {
    expect(flattenGamesPlayed([])).toEqual([]);
    expect(flattenGamesPlayed(null)).toEqual([]);
    expect(flattenGamesPlayed(undefined)).toEqual([]);
  });
});

describe('GAMES_PLAYED_SELECT', () => {
  it('orders oldest-first so the rendered list is stable', () => {
    expect(GAMES_PLAYED_SELECT.orderBy).toEqual({ createdAt: 'asc' });
  });

  it('asks for exactly the three fields the card renders', () => {
    expect(GAMES_PLAYED_SELECT.select.game.select).toEqual({
      id: true,
      name: true,
      iconUrl: true,
    });
  });
});
