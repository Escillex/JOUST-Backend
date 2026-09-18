/**
 * The self-declared "games I play" list, shaped the same way everywhere it is
 * served (`/auth/me`, `PATCH /auth/me`, the public profile).
 *
 * The relation is an explicit join (`UserGame`), so Prisma hands back rows that
 * wrap the game. Every reader wants the game itself, so the nesting is undone
 * once, here, rather than in each consumer — and the frontend gets one shape it
 * can render with a single component.
 */

/** The `select` for a user's games. Ordered oldest-first so the list a person
 *  sees does not reshuffle between requests. */
export const GAMES_PLAYED_SELECT = {
  orderBy: { createdAt: 'asc' },
  select: {
    game: { select: { id: true, name: true, iconUrl: true } },
  },
} as const;

export type GamePlayed = { id: string; name: string; iconUrl: string | null };

type GamesPlayedRow = { game: GamePlayed };

/** `[{ game: {...} }]` → `[{...}]`. */
export function flattenGamesPlayed(
  rows: GamesPlayedRow[] | undefined | null,
): GamePlayed[] {
  return (rows ?? []).map((row) => row.game);
}
