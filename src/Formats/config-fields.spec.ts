import { configFieldsForSystem, ConfigField } from './config-fields.helper';
import { resolveConfig } from './format-config.helper';

/**
 * This catalog IS the `TournamentFormat.configFields` contract. The frontend's
 * rules editor renders whatever it describes and nothing else, so an omission
 * here is invisible on the backend and total on the frontend — which is exactly
 * how the editor shipped permanently empty (CLAUDE.md Core Rule 9).
 *
 * The tests therefore check the catalog's *promises* rather than its prose:
 * every field is renderable, every stated default matches what `resolveConfig`
 * actually applies, and each system offers only rules its engine reads.
 */

const SYSTEMS = [
  'SWISS',
  'ROUND_ROBIN',
  'HYBRID',
  'SINGLE_ELIMINATION',
  'DOUBLE_ELIMINATION',
] as const;

const keysOf = (system: string) =>
  configFieldsForSystem(system).map((f) => f.key);
const fieldOf = (system: string, key: string) =>
  configFieldsForSystem(system).find((f) => f.key === key);

describe('configFieldsForSystem — the contract holds for every system', () => {
  it.each(SYSTEMS)('%s returns a non-empty, renderable catalog', (system) => {
    const fields = configFieldsForSystem(system);
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) {
      expect(typeof f.key).toBe('string');
      expect(f.key).not.toBe('');
      expect(f.label).toBeTruthy();
      expect(['number', 'boolean', 'select', 'array', 'string']).toContain(
        f.type,
      );
    }
  });

  it.each(SYSTEMS)('%s lists no key twice', (system) => {
    const keys = keysOf(system);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(SYSTEMS)('%s gives every select its options', (system) => {
    for (const f of configFieldsForSystem(system)) {
      if (f.type === 'select') {
        expect(Array.isArray(f.options)).toBe(true);
        expect(f.options!.length).toBeGreaterThan(1);
        // The stated default must be one of the offered values, or the editor
        // opens showing a value the select cannot represent.
        if (f.defaultValue !== undefined && f.defaultValue !== null) {
          expect(f.options).toContain(String(f.defaultValue));
        }
      }
    }
  });

  it('falls back to the universal fields for an unknown system', () => {
    const keys = keysOf('LADDER');
    expect(keys).toContain('bestOf');
    expect(keys).toContain('seedingMode');
    // …but offers nothing system-specific.
    expect(keys).not.toContain('swissPointsForWin');
    expect(keys).not.toContain('grandFinalReset');
  });
});

describe('configFieldsForSystem — rules that apply everywhere', () => {
  const ALWAYS = [
    'bestOf',
    'seedingMode',
    'scoreSubmissionRule',
    'matchStartWho',
    'utilitiesEnabled',
    'utilityCoinWho',
    'utilityDiceWho',
    'utilityTimerWho',
    'placementPointsChampion',
    'placementPointsParticipation',
  ];

  it.each(SYSTEMS)(
    '%s offers the universal, permission and placement rules',
    (system) => {
      expect(keysOf(system)).toEqual(expect.arrayContaining(ALWAYS));
    },
  );

  it('offers the four match-utility permissions with the same option set', () => {
    const expected = [
      'NONE',
      'STAFF',
      'PARTICIPANTS',
      'STAFF_AND_PARTICIPANTS',
    ];
    for (const key of ['utilityCoinWho', 'utilityDiceWho', 'utilityTimerWho']) {
      expect(fieldOf('SWISS', key)!.options).toEqual(expected);
    }
  });
});

describe('configFieldsForSystem — per-system rules', () => {
  it('offers draw and points-ranked rules only where a draw can be survived', () => {
    // Mirrors systemAllowsDraw: a drawn result on a bracket advances nobody.
    for (const system of ['SWISS', 'ROUND_ROBIN', 'HYBRID']) {
      expect(keysOf(system)).toEqual(
        expect.arrayContaining([
          'allowDraw',
          'swissPointsForWin',
          'byeResult',
          'tieBreakerOrder',
        ]),
      );
    }
    for (const system of ['SINGLE_ELIMINATION', 'DOUBLE_ELIMINATION']) {
      for (const key of [
        'allowDraw',
        'swissPointsForWin',
        'byeResult',
        'tieBreakerOrder',
      ]) {
        expect(keysOf(system)).not.toContain(key);
      }
    }
  });

  it('offers swissRounds only where rounds are not implied by the field size', () => {
    expect(keysOf('SWISS')).toContain('swissRounds');
    expect(keysOf('HYBRID')).toContain('swissRounds');
    // Round robin plays everyone; the count is the field, not a setting.
    expect(keysOf('ROUND_ROBIN')).not.toContain('swissRounds');
  });

  it('offers topCutSize and its placement tier to HYBRID alone', () => {
    expect(keysOf('HYBRID')).toContain('topCutSize');
    expect(keysOf('HYBRID')).toContain('placementPointsTopCut');
    for (const system of SYSTEMS.filter((s) => s !== 'HYBRID')) {
      expect(keysOf(system)).not.toContain('topCutSize');
      expect(keysOf(system)).not.toContain('placementPointsTopCut');
    }
  });

  it('offers grandFinalReset to DOUBLE_ELIMINATION alone', () => {
    expect(keysOf('DOUBLE_ELIMINATION')).toContain('grandFinalReset');
    for (const system of SYSTEMS.filter((s) => s !== 'DOUBLE_ELIMINATION')) {
      expect(keysOf(system)).not.toContain('grandFinalReset');
    }
  });
});

describe('configFieldsForSystem — never offer a control that does nothing', () => {
  it('omits the derived tracker outputs', () => {
    // trackingMode / useTracker / defaultStartingValue are computed by
    // resolveConfig from startingHp / pointsThreshold. Offering them would be
    // the same defect this catalog exists to fix (plan item 9.7).
    for (const system of SYSTEMS) {
      const keys = keysOf(system);
      expect(keys).not.toContain('trackingMode');
      expect(keys).not.toContain('useTracker');
      expect(keys).not.toContain('defaultStartingValue');
    }
  });

  it('offers the inputs those outputs are derived from instead', () => {
    expect(keysOf('SWISS')).toEqual(
      expect.arrayContaining(['startingHp', 'pointsThreshold']),
    );
  });

  it('omits the legacy winsToAdvance in favour of bestOf', () => {
    for (const system of SYSTEMS) {
      expect(keysOf(system)).not.toContain('winsToAdvance');
    }
  });
});

describe('configFieldsForSystem — stated defaults match resolveConfig', () => {
  // The catalog shows an organizer "what a blank field means". If the two ever
  // disagree, the editor lies about the effective value.
  const resolved = resolveConfig({}) as unknown as Record<string, any>;

  const CHECK: [string, string][] = [
    ['bestOf', 'bestOf'],
    ['seedingMode', 'seedingMode'],
    ['allowDraw', 'allowDraw'],
    ['swissPointsForWin', 'swissPointsForWin'],
    ['swissPointsForDraw', 'swissPointsForDraw'],
    ['swissPointsForLoss', 'swissPointsForLoss'],
    ['byeResult', 'byeResult'],
    ['grandFinalReset', 'grandFinalReset'],
    ['scoreSubmissionRule', 'scoreSubmissionRule'],
    ['matchStartWho', 'matchStartWho'],
    ['placementPointsChampion', 'placementPointsChampion'],
    ['placementPoints2nd', 'placementPoints2nd'],
    ['placementPoints3rd', 'placementPoints3rd'],
    ['placementPointsTopCut', 'placementPointsTopCut'],
    ['placementPointsParticipation', 'placementPointsParticipation'],
  ];

  it.each(CHECK)(
    '%s advertises the default resolveConfig applies',
    (key, resolvedKey) => {
      // Look the field up wherever it is offered.
      const field = SYSTEMS.map((s) => fieldOf(s, key)).find(
        Boolean,
      ) as ConfigField;
      expect(field).toBeDefined();
      expect(field.defaultValue).toBe(resolved[resolvedKey]);
    },
  );

  it('advertises the utility permission defaults resolveConfig applies', () => {
    const u = resolveConfig({}).utilities;
    expect(fieldOf('SWISS', 'utilitiesEnabled')!.defaultValue).toBe(u.enabled);
    expect(fieldOf('SWISS', 'utilityCoinWho')!.defaultValue).toBe(u.coinWho);
    expect(fieldOf('SWISS', 'utilityDiceWho')!.defaultValue).toBe(u.diceWho);
    expect(fieldOf('SWISS', 'utilityTimerWho')!.defaultValue).toBe(u.timerWho);
  });

  it('keeps numeric minimums sane', () => {
    for (const system of SYSTEMS) {
      for (const f of configFieldsForSystem(system)) {
        if (f.type !== 'number' || f.min === undefined) continue;
        expect(f.min).toBeGreaterThanOrEqual(0);
        if (typeof f.defaultValue === 'number') {
          expect(f.defaultValue).toBeGreaterThanOrEqual(f.min);
        }
      }
    }
  });
});
