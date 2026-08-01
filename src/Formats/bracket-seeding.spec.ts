import {
  standardSeedOrder,
  seedBracketSlots,
  shuffled,
} from './bracket-seeding.helper';
import { resolveConfig, systemAllowsDraw } from './format-config.helper';

/** Reproduces how the engine consumes the slots: adjacent pairs. */
function round1(players: number[]): [number | null, number | null][] {
  let size = 1;
  while (size < players.length) size *= 2;
  const slots = seedBracketSlots(players, size);
  const pairs: [number | null, number | null][] = [];
  for (let i = 0; i < slots.length; i += 2) {
    pairs.push([slots[i], slots[i + 1]]);
  }
  return pairs;
}

const field = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe('standardSeedOrder', () => {
  it('produces the canonical bracket layouts', () => {
    expect(standardSeedOrder(2)).toEqual([1, 2]);
    expect(standardSeedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(standardSeedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  it('is a permutation of 1..size', () => {
    for (const size of [2, 4, 8, 16, 32, 64]) {
      const order = standardSeedOrder(size);
      expect(order).toHaveLength(size);
      expect([...order].sort((a, b) => a - b)).toEqual(field(size));
    }
  });
});

describe('seedingMode', () => {
  it('defaults to RANDOM when nothing is configured', () => {
    expect(resolveConfig(null).seedingMode).toBe('RANDOM');
    expect(resolveConfig({}).seedingMode).toBe('RANDOM');
    expect(resolveConfig({ bestOf: 3 }).seedingMode).toBe('RANDOM');
  });

  it('only honours MANUAL when it is asked for explicitly', () => {
    expect(resolveConfig({ seedingMode: 'MANUAL' }).seedingMode).toBe('MANUAL');
    expect(resolveConfig({ seedingMode: 'RANDOM' }).seedingMode).toBe('RANDOM');
    // Anything unrecognised falls back to the safe default rather than being
    // treated as a manual arrangement that does not exist.
    expect(resolveConfig({ seedingMode: 'seeded' }).seedingMode).toBe('RANDOM');
    expect(resolveConfig({ seedingMode: true } as any).seedingMode).toBe(
      'RANDOM',
    );
  });

  it('reads from the root config on HYBRID, not the phase1 alias', () => {
    // resolveConfig aliases everything else to phase1 for HYBRID. How the field
    // is drawn belongs to the tournament, so it must survive that aliasing.
    const hybrid = { seedingMode: 'MANUAL', phase1: { bestOf: 1 }, phase2: {} };
    expect(resolveConfig(hybrid).seedingMode).toBe('MANUAL');
  });
});

describe('seedBracketSlots — properties every bracket must satisfy', () => {
  // Sizes chosen to cover exact powers of two and every awkward count between.
  const sizes = field(31).map((n) => n + 1); // 2..32

  it('never creates a match with both slots empty', () => {
    // This was the "TBD vs TBD" phantom: a match left PENDING forever because
    // nobody could ever be assigned to it.
    for (const n of sizes) {
      const phantoms = round1(field(n)).filter(
        ([a, b]) => a === null && b === null,
      );
      expect({ n, phantoms }).toEqual({ n, phantoms: [] });
    }
  });

  it('gives byes to the top seeds, never the bottom', () => {
    for (const n of sizes) {
      const byes = round1(field(n))
        .filter(([a, b]) => (a === null) !== (b === null))
        .map(([a, b]) => (a ?? b) as number)
        .sort((x, y) => x - y);
      // Byes must be exactly seeds 1..k for some k.
      expect({ n, byes }).toEqual({ n, byes: field(byes.length) });
    }
  });

  it('keeps every player, exactly once', () => {
    for (const n of sizes) {
      const present = round1(field(n))
        .flat()
        .filter((p): p is number => p !== null)
        .sort((a, b) => a - b);
      expect({ n, present }).toEqual({ n, present: field(n) });
    }
  });

  it('places seeds 1 and 2 in opposite halves, so they can only meet in the final', () => {
    for (const size of [4, 8, 16, 32, 64]) {
      const order = standardSeedOrder(size);
      const halfOf = (seed: number) =>
        order.indexOf(seed) < size / 2 ? 'top' : 'bottom';
      expect({ size, same: halfOf(1) === halfOf(2) }).toEqual({
        size,
        same: false,
      });
    }
  });

  it('gives the correct 5-player bracket', () => {
    // The case that shipped a phantom match: seeds 1-3 get byes, 4 plays 5.
    expect(round1(field(5))).toEqual([
      [1, null],
      [4, 5],
      [2, null],
      [3, null],
    ]);
  });

  it('shuffles without losing or duplicating anyone', () => {
    const input = field(50);
    for (let trial = 0; trial < 200; trial++) {
      const out = shuffled(input);
      expect([...out].sort((a, b) => a - b)).toEqual(input);
    }
    // And it must not return the input unchanged every time.
    const anyReordered = Array.from({ length: 50 }, () =>
      shuffled(input).join(),
    ).some((s) => s !== input.join());
    expect(anyReordered).toBe(true);
  });

  it('gives the correct 8-player bracket', () => {
    // Previously this produced 1v2, 3v4, 5v6, 7v8 — the top two seeds knocked
    // each other out in round one.
    expect(round1(field(8))).toEqual([
      [1, 8],
      [4, 5],
      [2, 7],
      [3, 6],
    ]);
  });
});

describe('systemAllowsDraw (plan 7.8)', () => {
  it('permits draws on the systems that rank on points', () => {
    expect(systemAllowsDraw('SWISS')).toBe(true);
    expect(systemAllowsDraw('ROUND_ROBIN')).toBe(true);
  });

  it('refuses draws on elimination brackets, which cannot advance without a winner', () => {
    // Single elim strands the next slot forever; double elim additionally
    // drops player 1 into the losers bracket because `player1Id === winnerId`
    // is false against a null winner.
    expect(systemAllowsDraw('SINGLE_ELIMINATION')).toBe(false);
    expect(systemAllowsDraw('DOUBLE_ELIMINATION')).toBe(false);
  });

  it('splits HYBRID by phase: Swiss stage yes, top cut no', () => {
    expect(systemAllowsDraw('HYBRID', 1)).toBe(true);
    expect(systemAllowsDraw('HYBRID', 2)).toBe(false);
  });

  it('defaults to phase 1 and refuses anything unrecognised', () => {
    expect(systemAllowsDraw('HYBRID')).toBe(true);
    expect(systemAllowsDraw(undefined)).toBe(false);
    expect(systemAllowsDraw(null)).toBe(false);
    expect(systemAllowsDraw('NOT_A_SYSTEM')).toBe(false);
  });
});
