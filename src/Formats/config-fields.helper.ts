import { TournamentSystem } from '@prisma/client';

/** One editable rule on a tournament's config.
 *
 *  Plan item 7.9. This catalog exists because the frontend's rules editor
 *  (`FormatRulesPanel`) was built to render whatever `configFields` the API
 *  described — but nothing on the backend ever produced it, so the array was
 *  permanently empty and organizers could not change a single rule after a
 *  tournament was created. CLAUDE.md Core Rule 9: a contract one side declares
 *  the other must honour.
 *
 *  The shape mirrors what `FormatRulesPanel` consumes. `type` is additive: the
 *  panel already infers booleans from `allowDraw`/boolean defaults and arrays
 *  from `tieBreakerOrder`, so an older client keeps working, but new clients
 *  should read `type` rather than re-deriving it from the key name. */
export interface ConfigField {
  key: string;
  label: string;
  placeholder: string;
  /** Default applied by `resolveConfig` when the key is absent. Shown as the
   *  effective value so an organizer can see what a blank field means. */
  defaultValue?: number | string | boolean | null;
  min?: number;
  max?: number;
  type: 'number' | 'boolean' | 'select' | 'array' | 'string';
  /** For `type: 'select'` — the permitted values. */
  options?: string[];
  /** Why this rule exists / what changing it does. */
  help?: string;
}

/** Rules that apply to every system. */
function universalFields(): ConfigField[] {
  return [
    {
      key: 'bestOf',
      label: 'Best Of',
      placeholder: '1',
      defaultValue: 1,
      min: 1,
      type: 'number',
      help: 'Games in a series. Wins needed is ceil(bestOf / 2), so 3 means first to 2.',
    },
    {
      key: 'seedingMode',
      label: 'Seeding',
      placeholder: 'RANDOM',
      defaultValue: 'RANDOM',
      type: 'select',
      options: ['RANDOM', 'MANUAL'],
      help: 'RANDOM draws the field at start and ignores the roster seed order. MANUAL follows it.',
    },
    {
      key: 'pointsThreshold',
      label: 'Points Threshold',
      placeholder: '0',
      defaultValue: 0,
      min: 0,
      type: 'number',
      help: 'Points that decide a game. 0 disables threshold scoring.',
    },
    {
      key: 'startingHp',
      label: 'Starting HP',
      placeholder: '0',
      defaultValue: 0,
      min: 0,
      type: 'number',
      help: 'Starting health for HP-tracked games. 0 disables HP tracking.',
    },
  ];
}

/** Rules that only mean anything where standings are computed from points. */
function pointsRankedFields(includeSwissRounds: boolean): ConfigField[] {
  const fields: ConfigField[] = [
    {
      key: 'allowDraw',
      label: 'Allow Draws',
      placeholder: 'No',
      defaultValue: false,
      type: 'boolean',
      help: 'Permits a result with no winner. Only offered where a draw cannot strand a bracket, and never on a series or threshold-scored match.',
    },
    {
      key: 'swissPointsForWin',
      label: 'Points For Win',
      placeholder: '3',
      defaultValue: 3,
      min: 0,
      type: 'number',
    },
    {
      key: 'swissPointsForDraw',
      label: 'Points For Draw',
      placeholder: '1',
      defaultValue: 1,
      min: 0,
      type: 'number',
    },
    {
      key: 'swissPointsForLoss',
      label: 'Points For Loss',
      placeholder: '0',
      defaultValue: 0,
      min: 0,
      type: 'number',
    },
    {
      key: 'tieBreakerOrder',
      label: 'Tiebreakers',
      placeholder: 'omw, oomw, matchWinPct',
      defaultValue: 'omw, oomw, matchWinPct',
      type: 'array',
      help: 'Comma-separated, most significant first. Valid: omw, oomw, matchWinPct, wins, losses. Blank uses the default order.',
    },
  ];

  if (includeSwissRounds) {
    fields.splice(1, 0, {
      key: 'swissRounds',
      label: 'Swiss Rounds',
      placeholder: 'Auto',
      defaultValue: null,
      min: 1,
      type: 'number',
      help: 'Blank auto-calculates from the player count.',
    });
  }

  return fields;
}

/** Global points awarded on completion, by finishing position. */
function placementFields(includeTopCut: boolean): ConfigField[] {
  const fields: ConfigField[] = [
    {
      key: 'placementPointsChampion',
      label: 'Placement Points — 1st',
      placeholder: '10',
      defaultValue: 10,
      min: 0,
      type: 'number',
    },
    {
      key: 'placementPoints2nd',
      label: 'Placement Points — 2nd',
      placeholder: '7',
      defaultValue: 7,
      min: 0,
      type: 'number',
    },
    {
      key: 'placementPoints3rd',
      label: 'Placement Points — 3rd',
      placeholder: '5',
      defaultValue: 5,
      min: 0,
      type: 'number',
    },
  ];

  if (includeTopCut) {
    fields.push({
      key: 'placementPointsTopCut',
      label: 'Placement Points — Top Cut',
      placeholder: '3',
      defaultValue: 3,
      min: 0,
      type: 'number',
      help: 'Awarded to 4th and below within the top cut.',
    });
  }

  fields.push({
    key: 'placementPointsParticipation',
    label: 'Placement Points — Participation',
    placeholder: '1',
    defaultValue: 1,
    min: 0,
    type: 'number',
  });

  return fields;
}

/**
 * The editable rules for a given system.
 *
 * Only fields the engine actually reads are listed. Deliberately excluded:
 * `trackingMode`, `useTracker` and `defaultStartingValue` are *derived outputs*
 * of `resolveConfig` (computed from `startingHp` / `pointsThreshold`), never
 * stored and never read back — listing them would offer an organizer a control
 * that silently does nothing, which is the same defect this catalog fixes.
 * That gap is tracked separately as plan item 9.7.
 *
 * Draw-related and points-ranked fields are omitted from elimination systems
 * because a drawn result cannot be advanced there at all — see `systemAllowsDraw`.
 */
export function configFieldsForSystem(
  system: TournamentSystem | string,
): ConfigField[] {
  switch (system) {
    case 'SWISS':
      return [
        ...universalFields(),
        ...pointsRankedFields(true),
        ...placementFields(false),
      ];

    case 'ROUND_ROBIN':
      return [
        ...universalFields(),
        ...pointsRankedFields(false),
        ...placementFields(false),
      ];

    case 'HYBRID':
      // Phase 1 is Swiss, so its point rules apply; the phase-2 top cut adds
      // its own placement tier.
      return [
        ...universalFields(),
        ...pointsRankedFields(true),
        {
          key: 'topCutSize',
          label: 'Top Cut Size',
          placeholder: '8',
          defaultValue: 8,
          min: 2,
          type: 'number',
          help: 'How many players advance from the Swiss phase into the elimination cut.',
        },
        ...placementFields(true),
      ];

    case 'SINGLE_ELIMINATION':
    case 'DOUBLE_ELIMINATION':
      return [...universalFields(), ...placementFields(false)];

    default:
      return universalFields();
  }
}
