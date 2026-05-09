import { FormatConfig } from '@prisma/client';

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

export function resolveConfig(config: FormatConfig | null): ResolvedConfig {
  return {
    bestOf:               config?.bestOf            ?? 1,
    winsToAdvance:        config?.winsToAdvance      ?? 1,
    allowDraw:            config?.allowDraw           ?? false,
    swissRounds:          config?.swissRounds        ?? null,
    swissPointsForWin:    config?.swissPointsForWin  ?? 3,
    swissPointsForDraw:   config?.swissPointsForDraw ?? 1,
    swissPointsForLoss:   config?.swissPointsForLoss ?? 0,
    tieBreakerOrder:      config?.tieBreakerOrder    ?? [],
    sessionsCount:        config?.sessionsCount       ?? 1,
    pointsPerSession:     config?.pointsPerSession   ?? 0,
    pointsThreshold:      config?.pointsThreshold    ?? 0,
    progressionType:      config?.progressionType    ?? null,
  };
}

/** How many wins are needed to win a match given bestOf */
export function winsNeeded(bestOf: number): number {
  return Math.ceil(bestOf / 2);
}