import { TournamentSystem } from '@prisma/client';
// Resolves a raw config JSON blob (from TournamentFormat.config)
// into a typed, defaults-applied config object.

/** How players are placed into the bracket.
 *  RANDOM - draw the field at random (the default; what most events do).
 *  MANUAL - honour the organizer's arranged order from the seed column. */
export type SeedingMode = 'RANDOM' | 'MANUAL';

/** What a bye is worth in a points-scored system (Swiss / round robin / hybrid
 *  phase 1). A bye is given to the lowest-standing player who has not had one, so
 *  it never hands a contender a free result — but organizers can still tune how
 *  generous it is. Inert in elimination, where a bye only advances a player.
 *  WIN  - counts as a win (full points). The default and the standard practice.
 *  DRAW - counts as a draw (draw points), with no winner recorded.
 *  NONE - not counted at all: no points, no game, no winner. */
export type ByeResult = 'WIN' | 'DRAW' | 'NONE';

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
  byeResult: ByeResult;
  // Double elimination only. When true (the default — this is what makes it
  // "double" elimination), if the losers-bracket finalist wins the grand final a
  // deciding reset match is played, so the winners-bracket finalist must be beaten
  // twice. When false the grand final is a single match (F15).
  grandFinalReset: boolean;

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

  // Shared match-utilities permissions (docs/shared-utilities-plan.md). Who may
  // trigger each utility, resolved from config so it's configurable per
  // tournament/game rather than hardcoded. Enforced server-side by MatchUtilityService.
  utilities: UtilitiesConfig;

  // Who may submit match scores. "Organizer must be present" rule (STAFF_ONLY)
  // enforces strict supervision. Otherwise, players can self-report (which goes
  // into pending verification).
  scoreSubmissionRule: ScoreSubmissionRule;

  // Who may move a match from PENDING to ONGOING. The default is
  // STAFF_AND_PARTICIPANTS — organizer-only start suits a supervised venue and
  // obstructs a casual one, where the players are at the table and the
  // organizer is not. STAFF restores the strict flow.
  matchStartWho: MatchStartWho;
}

/** Who may submit a match score. STAFF_ONLY is the strict, supervised setting. */
export type ScoreSubmissionRule = 'STAFF_ONLY' | 'SELF_REPORT_ALLOWED';

/** Who may move a match from PENDING to ONGOING. STAFF_AND_PARTICIPANTS (the
 *  default) is the casual setting: the players are at the table and the
 *  organizer is not. STAFF is what a supervised venue opts into. Enforced in
 *  `MatchService.startMatch` — like player self-scoring, the answer depends on
 *  the tournament's configuration, which a guard does not read. */
export type MatchStartWho = 'STAFF' | 'STAFF_AND_PARTICIPANTS';

const SCORE_SUBMISSION_RULES: readonly ScoreSubmissionRule[] = [
  'STAFF_ONLY',
  'SELF_REPORT_ALLOWED',
];

function resolveScoreSubmissionRule(raw: unknown): ScoreSubmissionRule {
  return SCORE_SUBMISSION_RULES.includes(raw as ScoreSubmissionRule)
    ? (raw as ScoreSubmissionRule)
    : 'SELF_REPORT_ALLOWED';
}

/** Who may trigger a shared utility. NONE = the utility is off/hidden. */
export type UtilityPerm =
  | 'NONE'
  | 'STAFF'
  | 'PARTICIPANTS'
  | 'STAFF_AND_PARTICIPANTS';

export interface UtilitiesConfig {
  enabled: boolean; // master switch — "optional to the game"
  coinWho: UtilityPerm;
  diceWho: UtilityPerm;
  timerWho: UtilityPerm;
}

const UTILITY_PERMS: readonly UtilityPerm[] = [
  'NONE',
  'STAFF',
  'PARTICIPANTS',
  'STAFF_AND_PARTICIPANTS',
];

/** Narrow an unknown config value to a UtilityPerm, falling back to `fallback`. */
function resolvePerm(value: unknown, fallback: UtilityPerm): UtilityPerm {
  return UTILITY_PERMS.includes(value as UtilityPerm)
    ? (value as UtilityPerm)
    : fallback;
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

/** The bracket type a tournament actually runs on: its own snapshot once it has
 *  started, else the live preset. Mirrors `effectiveRawConfig`, and is the only
 *  thing that should read `format.system` — a started tournament must not need
 *  its preset to still exist (todo.md §4). */
export function systemOf(
  tournament:
    | {
        system?: TournamentSystem | null;
        format?: { system?: TournamentSystem | null } | null;
      }
    | null
    | undefined,
): TournamentSystem | undefined {
  return tournament?.system ?? tournament?.format?.system ?? undefined;
}

/** The preset's name as this tournament knows it: its snapshot, else the live
 *  preset's. */
export function formatNameOf(
  tournament:
    | { formatName?: string | null; format?: { name?: string | null } | null }
    | null
    | undefined,
): string | null {
  return tournament?.formatName ?? tournament?.format?.name ?? null;
}

/**
 * Present a tournament's format as the tournament itself knows it: once it has
 * started, its snapshotted bracket type and preset name stand in for the live
 * preset — which may since have been renamed, changed, or deleted.
 *
 * Shaping the response here rather than at ~20 read sites keeps every consumer
 * (bracket views, lobby, report, manage list, invite page) correct by default,
 * including when `format` is null because the preset is gone.
 */
export function withFormatSnapshot<
  T extends {
    system?: TournamentSystem | null;
    formatName?: string | null;
    format?: { system?: TournamentSystem | null; name?: string | null } | null;
  },
>(tournament: T): T {
  if (!tournament) return tournament;
  const system = systemOf(tournament);
  const name = formatNameOf(tournament);
  if (!system && !name) return tournament;
  return {
    ...tournament,
    format: {
      ...(tournament.format ?? {}),
      ...(system ? { system } : {}),
      ...(name ? { name } : {}),
    },
  } as T;
}

export function resolveConfig(
  config: Record<string, any> | null,
  phase?: number,
): ResolvedConfig {
  // Hybrid stores per-phase rules. Resolve a match's rules from the phase it
  // belongs to — phase 2 (the top cut) from `phase2`, otherwise `phase1` — each
  // merged OVER the root so a flat (un-nested) config still works and root-level
  // edits are always honoured. Non-hybrid configs have neither key and resolve
  // straight from the root. This is the single accessor every path uses, so
  // phase-2 rules (e.g. bestOf for the top cut) are no longer silently dropped and
  // the completion logic and the match logic can't disagree about the shape (F4).
  const base = config ?? {};
  const p1 = base.phase1 && typeof base.phase1 === 'object' ? (base.phase1 as Record<string, any>) : {};
  const p2 = base.phase2 && typeof base.phase2 === 'object' ? (base.phase2 as Record<string, any>) : {};
  // For phase 2 (top cut), inherit game rules (startingHp, pointsThreshold, etc.)
  // from phase 1 unless explicitly overridden by phase 2.
  const phaseObj = phase === 2 ? { ...p1, ...p2 } : p1;
  const c =
    phaseObj && Object.keys(phaseObj).length > 0
      ? { ...base, ...phaseObj }
      : base;

  // `bestOf` is the number of games in the series; winsNeeded is ceil(bestOf/2).
  // Legacy configs stored `winsToAdvance` (the number of wins to take the series,
  // i.e. first-to-N). Treating that value as `bestOf` halved the series — first-to-2
  // became bestOf 2 → winsNeeded 1, deciding the match after a single game (F12).
  // Convert it: a first-to-N series is bestOf 2N-1, so winsNeeded lands back on N.
  const wins =
    c.bestOf ??
    (typeof c.winsToAdvance === 'number' && c.winsToAdvance > 0
      ? c.winsToAdvance * 2 - 1
      : 1);

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
    // Default WIN (standard). Any unrecognised value falls back to WIN rather
    // than silently disabling bye scoring.
    byeResult:
      c.byeResult === 'DRAW' || c.byeResult === 'NONE' ? c.byeResult : 'WIN',
    // Default true: a bracket reset is what makes double elimination actually
    // double — the winners-bracket finalist has to be beaten twice (F15).
    grandFinalReset: c.grandFinalReset === false ? false : true,

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

    // Match utilities — read from ROOT first (like seedingMode, these belong to
    // the event, not a hybrid Swiss phase), then the phase alias. Defaults make
    // the feature work unconfigured: timer staff-only, coin/dice open to staff
    // and the two players.
    utilities: {
      enabled:
        (config?.utilitiesEnabled ?? c.utilitiesEnabled) === false
          ? false
          : true,
      coinWho: resolvePerm(
        config?.utilityCoinWho ?? c.utilityCoinWho,
        'STAFF_AND_PARTICIPANTS',
      ),
      diceWho: resolvePerm(
        config?.utilityDiceWho ?? c.utilityDiceWho,
        'STAFF_AND_PARTICIPANTS',
      ),
      timerWho: resolvePerm(
        config?.utilityTimerWho ?? c.utilityTimerWho,
        'STAFF',
      ),
    },

    // a property of the event, not of a hybrid's Swiss phase.
    scoreSubmissionRule: resolveScoreSubmissionRule(
      config?.scoreSubmissionRule ?? c.scoreSubmissionRule,
    ),

    // Read from ROOT first (belongs to the event, not a hybrid's Swiss phase).
    // Anything other than the literal "STAFF" means the permissive default: the
    // two players plus staff may start.
    matchStartWho:
      (config?.matchStartWho ?? c.matchStartWho) === 'STAFF'
        ? 'STAFF'
        : 'STAFF_AND_PARTICIPANTS',
  };
}

/** How many wins are needed to win a match given bestOf.
 *  BO1 → 1, BO3 → 2, BO5 → 3, BO7 → 4, etc.
 */
export function winsNeeded(bestOf: number): number {
  return Math.ceil(bestOf / 2);
}
