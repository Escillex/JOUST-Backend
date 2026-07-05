// Resolves a raw config JSON blob (from TournamentFormat.config)
// into a typed, defaults-applied config object.

export interface ResolvedConfig {
  bestOf: number; // Redefined: now represents the number of wins required to advance
  winsToAdvance: number; // Derived alias
  allowDraw: boolean;
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
