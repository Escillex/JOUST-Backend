// Resolves a raw config JSON blob (from TournamentFormat.config)
// into a typed, defaults-applied config object.

/** How players are placed into the bracket.
 *  RANDOM - draw the field at random (the default; what most events do).
 *  MANUAL - honour the organizer's arranged order from the seed column. */
export type SeedingMode = 'RANDOM' | 'MANUAL';

/** Whether a drawn result (COMPLETED with `winnerId: null`) is survivable under
 *  this system. This is a correctness gate, not a preference.
 *
 *  `handleMatchCompletion` advances only `if (match.nextMatchId && match.winnerId)`,
 *  so on a bracket a draw means nobody advances and the next slot stays empty
 *  forever — and the match is already COMPLETED, so it cannot be resubmitted.
 *  Double elimination is worse than stalled: the loser is derived as
 *  `player1Id === winnerId ? player2Id : player1Id`, which with a null winner
 *  is false, so player 1 is silently dropped into the losers bracket.
 *
 *  HYBRID depends on the match, not the tournament: phase 1 IS Swiss and safe,
 *  phase 2 is the single-elimination top cut and is not.
 *
 *  Mirrored on the frontend by `systemAllowsDraw` in `new/app/utils/formatConfig.ts`;
 *  the two must agree (CLAUDE.md Core Rule 9). */
export function systemAllowsDraw(
  system: string | null | undefined,
  phase: number = 1,
): boolean {
  if (system === 'SWISS' || system === 'ROUND_ROBIN') return true;
  if (system === 'HYBRID') return phase === 1;
  return false;
}

export interface ResolvedConfig {
  bestOf: number; // Redefined: now represents the number of wins required to advance
  winsToAdvance: number; // Derived alias
  allowDraw: boolean;
  seedingMode: SeedingMode;
  swissRounds: number | null;
  swissPointsForWin: number;
  swissPointsForDraw: number;
  swissPointsForLoss: number;
  tieBreakerOrder: string[];

  pointsThreshold: number;
  startingHp: number;
  progressionType: string | null;
  useTracker: boolean;
  trackingMode: 'HP' | 'POINTS';
  defaultStartingValue: number | null; // null = auto-derive from bestOf

  // Placement-based global points awarded at tournament completion
  placementPointsChampion: number; // 1st place
  placementPoints2nd: number; // 2nd place
  placementPoints3rd: number; // 3rd place
  placementPointsTopCut: number; // 4th+ in HYBRID top-cut formats
  placementPointsParticipation: number; // all other finishers
}

/** Effective raw config for a tournament: the per-tournament override
 *  (Tournament.config) fully replaces the format preset's config when set. */
export function effectiveRawConfig(
  tournament:
    | {
        config?: unknown;
        format?: { config?: unknown } | null;
      }
    | null
    | undefined,
): Record<string, any> {
  return (
    (tournament?.config as Record<string, any>) ??
    (tournament?.format?.config as Record<string, any>) ??
    {}
  );
}

export function resolveConfig(
  config: Record<string, any> | null,
): ResolvedConfig {
  // For HYBRID formats, the root config IS the phase1 Swiss config for scoring purposes
  const c = config?.phase1 ?? config ?? {};

  // If old winsToAdvance exists, fall back to it, otherwise bestOf (or 1)
  const wins = c.bestOf ?? c.winsToAdvance ?? 1;

  const pointsThreshold = c.pointsThreshold ?? 0;
  const startingHp = c.startingHp ?? 0;
  const hasHp = startingHp > 0;
  const hasPoints = pointsThreshold > 0;

  return {
    bestOf: wins,
    winsToAdvance: wins,
    allowDraw: c.allowDraw ?? false,
    // Read from the ROOT config first, not the phase1 alias: how the field is
    // drawn is a property of the tournament, not of a HYBRID event's Swiss
    // phase. Falls back to the phase config so either nesting works.
    // Defaults to RANDOM — a draw is what an event does unless the organizer
    // has deliberately arranged the bracket. The previous behaviour was neither
    // random nor seeded: it took whatever order the database returned, which in
    // practice meant the first player to register was placed as if top seed.
    seedingMode:
      (config?.seedingMode ?? c.seedingMode) === 'MANUAL' ? 'MANUAL' : 'RANDOM',
    swissRounds: c.swissRounds ?? null,
    swissPointsForWin: c.swissPointsForWin ?? 3,
    swissPointsForDraw: c.swissPointsForDraw ?? 1,
    swissPointsForLoss: c.swissPointsForLoss ?? 0,
    tieBreakerOrder: c.tieBreakerOrder ?? [],

    pointsThreshold,
    startingHp,
    progressionType: c.progressionType ?? null,
    useTracker: hasHp || hasPoints,
    trackingMode: hasHp ? 'HP' : 'POINTS',
    defaultStartingValue: hasHp
      ? startingHp
      : hasPoints
        ? pointsThreshold
        : null,

    // Placement points — awarded at tournament completion
    placementPointsChampion: c.placementPointsChampion ?? 10,
    placementPoints2nd: c.placementPoints2nd ?? 7,
    placementPoints3rd: c.placementPoints3rd ?? 5,
    placementPointsTopCut: c.placementPointsTopCut ?? 3,
    placementPointsParticipation: c.placementPointsParticipation ?? 1,
  };
}

/** How many wins are needed to win a match given bestOf.
 *  BO1 → 1, BO3 → 2, BO5 → 3, BO7 → 4, etc.
 */
export function winsNeeded(bestOf: number): number {
  return Math.ceil(bestOf / 2);
}
