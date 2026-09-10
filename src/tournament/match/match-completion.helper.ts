import { MatchStatus, Prisma } from '@prisma/client';

/**
 * The single shape every "this match is finished" write uses.
 *
 * Matches reach COMPLETED from twelve places across `formats.service`,
 * `match.service` and `tournament.service` — normal submissions, draws,
 * walkovers, forfeits, byes and dead matches whose feeders delivered nobody.
 * There is no natural chokepoint to funnel them through, so the next best thing
 * is one shape they all spell the same way: grep `completedMatchData` and you
 * have every completion in the codebase, and a new one copies the pattern
 * instead of inventing a bare `status: COMPLETED` that forgets the timestamp.
 *
 * @param extra the winner (or its absence) and any other fields the caller sets.
 */
// The unchecked variant, because every call site sets scalar foreign keys
// (`winnerId`) rather than nested relation writes.
export function completedMatchData<T extends Prisma.MatchUncheckedUpdateInput>(
  extra?: T,
): T & { status: MatchStatus; completedAt: Date } {
  return {
    ...(extra ?? ({} as T)),
    status: MatchStatus.COMPLETED,
    completedAt: new Date(),
  };
}
