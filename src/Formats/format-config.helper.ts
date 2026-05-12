// Resolves a raw config JSON blob (from TournamentFormat.config)
// into a typed, defaults-applied config object.

export interface ResolvedConfig {
  bestOf: number;
  winsToAdvance: number;
  allowDraw: boolean;
  swissRounds: number | null;
  swissPointsForWin: number;
  swissPointsForDraw: number;
  swissPointsForLoss: number;
  tieBreakerOrder: string[];
  sessionsCount: number;
  pointsPerSession: number;
  pointsThreshold: number;
  progressionType: string | null;
}

export function resolveConfig(config: Record<string, any> | null): ResolvedConfig {
  // For HYBRID formats, the root config IS the phase1 Swiss config for scoring purposes
  const c = config?.phase1 ?? config ?? {};
  return {
    bestOf:               c.bestOf               ?? 1,
    winsToAdvance:        c.winsToAdvance         ?? 1,
    allowDraw:            c.allowDraw             ?? false,
    swissRounds:          c.swissRounds           ?? null,
    swissPointsForWin:    c.swissPointsForWin     ?? 3,
    swissPointsForDraw:   c.swissPointsForDraw    ?? 1,
    swissPointsForLoss:   c.swissPointsForLoss    ?? 0,
    tieBreakerOrder:      c.tieBreakerOrder       ?? [],
    sessionsCount:        c.sessionsCount          ?? 1,
    pointsPerSession:     c.pointsPerSession      ?? 0,
    pointsThreshold:      c.pointsThreshold       ?? 0,
    progressionType:      c.progressionType       ?? null,
  };
}

/** How many wins are needed to win a match given bestOf */
export function winsNeeded(bestOf: number): number {
  return Math.ceil(bestOf / 2);
}