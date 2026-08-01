/**
 * Standard single-elimination bracket seeding.
 *
 * Before this existed, three separate places padded the player list with nulls
 * at the END and paired adjacently (`playerIds[0]` vs `playerIds[1]`, and so
 * on). That is not a tournament bracket — it produced three defects at once:
 *
 *  1. **Byes went to the worst seeds.** Padding at the end means the trailing
 *     slots are empty, so with 7 players seed 7 got the free pass. Every real
 *     tournament gives byes to the TOP seeds; that is what a bye is for.
 *  2. **Phantom matches.** Whenever the player count sat below three quarters of
 *     the bracket size, adjacent pairing produced matches with BOTH slots empty
 *     — a match nobody can ever play, left PENDING forever and rendered in the
 *     bracket as "TBD vs TBD". A 5-player event produced one; a 9-player event
 *     produced three.
 *  3. **The top seeds met immediately.** Adjacent pairing puts seed 1 against
 *     seed 2 in round one. Seeding exists precisely to keep them apart until the
 *     final.
 *
 * The fix is the standard recursive fold. Build the slot order for a bracket of
 * size N by repeatedly doubling: each seed `s` in the current order is followed
 * by its complement `n + 1 - s`.
 *
 *   size 2:  [1, 2]
 *   size 4:  [1, 4, 2, 3]
 *   size 8:  [1, 8, 4, 5, 2, 7, 3, 6]
 *
 * Pairing those slots adjacently gives 1v8, 4v5, 2v7, 3v6 — the bracket every
 * tournament organizer expects. Because empty slots are always the highest seed
 * numbers, and the bracket size is the next power of two above the player count
 * (so the field is always more than half full), a pair can never be empty on
 * both sides. Phantom matches become structurally impossible rather than merely
 * unlikely.
 */

/**
 * Fisher-Yates shuffle, returning a new array.
 *
 * Shared rather than reimplemented per call site, for the same reason the seed
 * order is: this codebase already had three different bracket-pairing routines
 * that quietly disagreed with each other.
 */
export function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Slot order for a bracket of `size` (a power of two), as 1-based seed numbers. */
export function standardSeedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    const next: number[] = [];
    for (const seed of order) {
      next.push(seed, n + 1 - seed);
    }
    order = next;
  }
  return order;
}

/**
 * Places `players` (already ordered best-seed-first) into the bracket slots.
 * Slots beyond the end of the field become `null`, which the bracket builder
 * reads as a bye for that slot's opponent.
 */
export function seedBracketSlots<T>(players: T[], size: number): (T | null)[] {
  return standardSeedOrder(size).map((seed) => players[seed - 1] ?? null);
}
