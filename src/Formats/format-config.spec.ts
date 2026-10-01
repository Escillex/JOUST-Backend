import {
  effectiveRawConfig,
  formatNameOf,
  resolveConfig,
  systemAllowsDraw,
  systemOf,
  winsNeeded,
  withFormatSnapshot,
} from './format-config.helper';

/**
 * `resolveConfig` is the single accessor every engine path reads its rules
 * through, and it is mirrored field-for-field by `getTournamentConfig` in
 * `new/app/utils/formatConfig.ts` (Core Rule 9). Nothing covered it, so the
 * defaults and the precedence order — which is where the F4 and F12 defects
 * both lived — were load-bearing and untested.
 *
 * What is guarded here is behaviour an organizer would feel: what a blank
 * config means, whether a phase-2 top cut inherits phase-1 game rules, and
 * which keys are read from the ROOT rather than from a hybrid's Swiss phase.
 */

describe('resolveConfig — defaults', () => {
  it('resolves a null or empty config to a playable BO1 event', () => {
    for (const input of [null, {}]) {
      const c = resolveConfig(input);
      expect(c.bestOf).toBe(1);
      expect(c.winsToAdvance).toBe(1);
      expect(c.allowDraw).toBe(false);
      expect(c.seedingMode).toBe('RANDOM');
      expect(c.byeResult).toBe('WIN');
      expect(c.grandFinalReset).toBe(true);
      expect(c.tieBreakerOrder).toEqual([]);
    }
  });

  it('defaults Swiss points to 3/1/0', () => {
    const c = resolveConfig({});
    expect(c.swissPointsForWin).toBe(3);
    expect(c.swissPointsForDraw).toBe(1);
    expect(c.swissPointsForLoss).toBe(0);
    expect(c.swissRounds).toBeNull();
  });

  it('defaults placement points to 10 / 7 / 5 / 3 / 1', () => {
    const c = resolveConfig({});
    expect([
      c.placementPointsChampion,
      c.placementPoints2nd,
      c.placementPoints3rd,
      c.placementPointsTopCut,
      c.placementPointsParticipation,
    ]).toEqual([10, 7, 5, 3, 1]);
  });

  it('defaults the two "who may act" rules to the permissive setting', () => {
    const c = resolveConfig({});
    expect(c.scoreSubmissionRule).toBe('SELF_REPORT_ALLOWED');
    expect(c.matchStartWho).toBe('STAFF_AND_PARTICIPANTS');
  });
});

describe('resolveConfig — bestOf and the legacy winsToAdvance conversion', () => {
  it('passes bestOf through untouched', () => {
    expect(resolveConfig({ bestOf: 3 }).bestOf).toBe(3);
    expect(resolveConfig({ bestOf: 5 }).bestOf).toBe(5);
  });

  it('converts a legacy first-to-N into bestOf 2N-1 (F12)', () => {
    // The defect: treating winsToAdvance as bestOf halved the series, so
    // first-to-2 decided after a single game.
    expect(resolveConfig({ winsToAdvance: 2 }).bestOf).toBe(3);
    expect(winsNeeded(resolveConfig({ winsToAdvance: 2 }).bestOf)).toBe(2);
    expect(resolveConfig({ winsToAdvance: 3 }).bestOf).toBe(5);
    expect(winsNeeded(resolveConfig({ winsToAdvance: 3 }).bestOf)).toBe(3);
  });

  it('prefers an explicit bestOf over a legacy winsToAdvance', () => {
    expect(resolveConfig({ bestOf: 5, winsToAdvance: 2 }).bestOf).toBe(5);
  });

  it('ignores a non-positive or non-numeric winsToAdvance', () => {
    expect(resolveConfig({ winsToAdvance: 0 }).bestOf).toBe(1);
    expect(resolveConfig({ winsToAdvance: -1 }).bestOf).toBe(1);
    expect(resolveConfig({ winsToAdvance: '2' as any }).bestOf).toBe(1);
  });
});

describe('winsNeeded', () => {
  it('is ceil(bestOf / 2)', () => {
    expect([1, 3, 5, 7, 9].map(winsNeeded)).toEqual([1, 2, 3, 4, 5]);
  });

  it('rounds an even bestOf up, so a drawn series is impossible', () => {
    expect(winsNeeded(2)).toBe(1);
    expect(winsNeeded(4)).toBe(2);
  });
});

describe('resolveConfig — phase resolution (F4)', () => {
  const hybrid = {
    bestOf: 1,
    startingHp: 20,
    phase1: { bestOf: 1, swissRounds: 4 },
    phase2: { bestOf: 3 },
  };

  it('reads phase 1 by default', () => {
    expect(resolveConfig(hybrid).bestOf).toBe(1);
    expect(resolveConfig(hybrid, 1).bestOf).toBe(1);
    expect(resolveConfig(hybrid).swissRounds).toBe(4);
  });

  it('reads phase 2 for the top cut', () => {
    expect(resolveConfig(hybrid, 2).bestOf).toBe(3);
  });

  it('lets phase 2 inherit phase-1 game rules it does not override', () => {
    // phase2 says nothing about swissRounds, so phase 1's value carries.
    expect(resolveConfig(hybrid, 2).swissRounds).toBe(4);
  });

  it('merges the phase OVER the root, so a flat config still works', () => {
    expect(resolveConfig({ bestOf: 5 }, 2).bestOf).toBe(5);
    expect(
      resolveConfig({ startingHp: 20, phase2: { bestOf: 3 } }, 2).startingHp,
    ).toBe(20);
  });

  it('ignores a phase key that is not an object', () => {
    const c = resolveConfig({ bestOf: 3, phase1: 'nonsense' as any }, 1);
    expect(c.bestOf).toBe(3);
  });
});

describe('resolveConfig — keys read from the ROOT, not the phase alias', () => {
  // These belong to the event, not to a hybrid's Swiss phase. A phase-1 value
  // must not be able to override the organizer's root-level choice.
  const cases: [string, any, keyof ReturnType<typeof resolveConfig>, any][] = [
    ['seedingMode', 'MANUAL', 'seedingMode', 'MANUAL'],
    ['scoreSubmissionRule', 'STAFF_ONLY', 'scoreSubmissionRule', 'STAFF_ONLY'],
    ['matchStartWho', 'STAFF', 'matchStartWho', 'STAFF'],
  ];

  it.each(cases)(
    'honours a root-level %s even when phase1 disagrees',
    (key, rootValue, field, expected) => {
      const config: Record<string, any> = {
        [key]: rootValue,
        phase1: { [key]: 'SOMETHING_ELSE' },
      };
      expect(resolveConfig(config, 1)[field]).toBe(expected);
    },
  );

  it('still falls back to the phase value when the root says nothing', () => {
    expect(
      resolveConfig({ phase1: { seedingMode: 'MANUAL' } }, 1).seedingMode,
    ).toBe('MANUAL');
  });
});

describe('resolveConfig — enum narrowing', () => {
  it('only honours MANUAL seeding when asked for explicitly', () => {
    expect(resolveConfig({ seedingMode: 'MANUAL' }).seedingMode).toBe('MANUAL');
    expect(resolveConfig({ seedingMode: 'manual' }).seedingMode).toBe('RANDOM');
    expect(resolveConfig({ seedingMode: 'SEEDED' }).seedingMode).toBe('RANDOM');
  });

  it('accepts the three byeResult values and falls back to WIN', () => {
    expect(resolveConfig({ byeResult: 'DRAW' }).byeResult).toBe('DRAW');
    expect(resolveConfig({ byeResult: 'NONE' }).byeResult).toBe('NONE');
    // An unrecognised value must not silently disable bye scoring.
    expect(resolveConfig({ byeResult: 'ZERO' }).byeResult).toBe('WIN');
    expect(resolveConfig({ byeResult: null }).byeResult).toBe('WIN');
  });

  it('treats grandFinalReset as on unless it is literally false', () => {
    expect(resolveConfig({ grandFinalReset: false }).grandFinalReset).toBe(
      false,
    );
    expect(resolveConfig({ grandFinalReset: true }).grandFinalReset).toBe(true);
    expect(
      resolveConfig({ grandFinalReset: 'no' as any }).grandFinalReset,
    ).toBe(true);
    expect(resolveConfig({}).grandFinalReset).toBe(true);
  });

  it('falls back to the permissive rule for an unknown scoreSubmissionRule', () => {
    expect(
      resolveConfig({ scoreSubmissionRule: 'NOBODY' }).scoreSubmissionRule,
    ).toBe('SELF_REPORT_ALLOWED');
  });

  it('treats anything but the literal "STAFF" as the permissive matchStartWho', () => {
    expect(resolveConfig({ matchStartWho: 'staff' }).matchStartWho).toBe(
      'STAFF_AND_PARTICIPANTS',
    );
  });
});

describe('resolveConfig — derived tracker settings', () => {
  // trackingMode / useTracker / defaultStartingValue are computed, never stored.
  // Mirrored by getTrackerSettings() on the frontend.
  it('is off when neither HP nor a points threshold is configured', () => {
    const c = resolveConfig({});
    expect(c.useTracker).toBe(false);
    expect(c.defaultStartingValue).toBeNull();
    expect(c.trackingMode).toBe('POINTS');
  });

  it('derives HP mode from startingHp', () => {
    const c = resolveConfig({ startingHp: 20 });
    expect(c.useTracker).toBe(true);
    expect(c.trackingMode).toBe('HP');
    expect(c.defaultStartingValue).toBe(20);
  });

  it('derives POINTS mode from pointsThreshold', () => {
    const c = resolveConfig({ pointsThreshold: 30 });
    expect(c.useTracker).toBe(true);
    expect(c.trackingMode).toBe('POINTS');
    expect(c.defaultStartingValue).toBe(30);
  });

  it('prefers HP when both are set', () => {
    const c = resolveConfig({ startingHp: 20, pointsThreshold: 30 });
    expect(c.trackingMode).toBe('HP');
    expect(c.defaultStartingValue).toBe(20);
  });
});

describe('resolveConfig — match utilities', () => {
  it('ships usable unconfigured: coin and dice open, timer staff-only', () => {
    const u = resolveConfig({}).utilities;
    expect(u).toEqual({
      enabled: true,
      coinWho: 'STAFF_AND_PARTICIPANTS',
      diceWho: 'STAFF_AND_PARTICIPANTS',
      timerWho: 'STAFF',
    });
  });

  it('turns off only on a literal false', () => {
    expect(resolveConfig({ utilitiesEnabled: false }).utilities.enabled).toBe(
      false,
    );
    expect(
      resolveConfig({ utilitiesEnabled: 'false' as any }).utilities.enabled,
    ).toBe(true);
  });

  it('accepts the four permission values', () => {
    for (const perm of [
      'NONE',
      'STAFF',
      'PARTICIPANTS',
      'STAFF_AND_PARTICIPANTS',
    ]) {
      expect(resolveConfig({ utilityCoinWho: perm }).utilities.coinWho).toBe(
        perm,
      );
    }
  });

  it('falls back rather than accepting an unknown permission', () => {
    expect(
      resolveConfig({ utilityTimerWho: 'EVERYONE' }).utilities.timerWho,
    ).toBe('STAFF');
    expect(resolveConfig({ utilityDiceWho: null }).utilities.diceWho).toBe(
      'STAFF_AND_PARTICIPANTS',
    );
  });

  it('reads utilities from the root ahead of a phase alias', () => {
    const c = resolveConfig(
      { utilityCoinWho: 'STAFF', phase1: { utilityCoinWho: 'PARTICIPANTS' } },
      1,
    );
    expect(c.utilities.coinWho).toBe('STAFF');
  });
});

describe('systemAllowsDraw', () => {
  // A correctness gate, not a preference: on a bracket a drawn match advances
  // nobody and cannot be resubmitted, and double elimination silently drops
  // player 1 into the losers bracket.
  it('allows draws in the points-ranked systems', () => {
    expect(systemAllowsDraw('SWISS')).toBe(true);
    expect(systemAllowsDraw('ROUND_ROBIN')).toBe(true);
  });

  it('refuses draws in both elimination systems', () => {
    expect(systemAllowsDraw('SINGLE_ELIMINATION')).toBe(false);
    expect(systemAllowsDraw('DOUBLE_ELIMINATION')).toBe(false);
  });

  it('makes HYBRID depend on the phase, not the tournament', () => {
    expect(systemAllowsDraw('HYBRID', 1)).toBe(true);
    expect(systemAllowsDraw('HYBRID')).toBe(true); // phase defaults to 1
    expect(systemAllowsDraw('HYBRID', 2)).toBe(false); // the top cut is a bracket
  });

  it('refuses for an unknown or missing system', () => {
    expect(systemAllowsDraw(null)).toBe(false);
    expect(systemAllowsDraw(undefined)).toBe(false);
    expect(systemAllowsDraw('LADDER')).toBe(false);
  });
});

describe('effectiveRawConfig', () => {
  it('prefers the tournament override over the preset', () => {
    expect(
      effectiveRawConfig({
        config: { bestOf: 5 },
        format: { config: { bestOf: 1 } },
      }),
    ).toEqual({ bestOf: 5 });
  });

  it('falls back to the preset when the tournament has no override', () => {
    expect(effectiveRawConfig({ format: { config: { bestOf: 3 } } })).toEqual({
      bestOf: 3,
    });
  });

  it('returns an empty object rather than null for anything missing', () => {
    expect(effectiveRawConfig(null)).toEqual({});
    expect(effectiveRawConfig(undefined)).toEqual({});
    expect(effectiveRawConfig({})).toEqual({});
    expect(effectiveRawConfig({ format: null })).toEqual({});
  });

  it('replaces the preset wholesale — it does not merge', () => {
    // An override is a full replacement, so a key only the preset had is gone.
    const raw = effectiveRawConfig({
      config: { bestOf: 5 },
      format: { config: { bestOf: 1, startingHp: 20 } },
    });
    expect(raw.startingHp).toBeUndefined();
  });
});

describe('systemOf / formatNameOf — the started-tournament snapshot (todo.md §4)', () => {
  it('prefers the tournament snapshot over the live preset', () => {
    const t = {
      system: 'SWISS' as any,
      formatName: 'Winter Swiss',
      format: { system: 'HYBRID' as any, name: 'Renamed Since' },
    };
    expect(systemOf(t)).toBe('SWISS');
    expect(formatNameOf(t)).toBe('Winter Swiss');
  });

  it('falls back to the live preset before the tournament has started', () => {
    const t = { format: { system: 'HYBRID' as any, name: 'House Hybrid' } };
    expect(systemOf(t)).toBe('HYBRID');
    expect(formatNameOf(t)).toBe('House Hybrid');
  });

  it('survives a deleted preset once the snapshot exists', () => {
    const t = {
      system: 'SWISS' as any,
      formatName: 'Winter Swiss',
      format: null,
    };
    expect(systemOf(t)).toBe('SWISS');
    expect(formatNameOf(t)).toBe('Winter Swiss');
  });

  it('reports undefined / null when there is nothing to report', () => {
    expect(systemOf(null)).toBeUndefined();
    expect(systemOf({})).toBeUndefined();
    expect(formatNameOf(null)).toBeNull();
    expect(formatNameOf({})).toBeNull();
  });
});

describe('withFormatSnapshot', () => {
  it('presents the snapshot through `format`, so the ~20 read sites need no change', () => {
    const out = withFormatSnapshot({
      system: 'SWISS' as any,
      formatName: 'Winter Swiss',
      format: { system: 'HYBRID' as any, name: 'Renamed Since' },
    });
    expect(out.format).toEqual({ system: 'SWISS', name: 'Winter Swiss' });
  });

  it('synthesises a format object when the preset is gone', () => {
    const out = withFormatSnapshot({
      system: 'DOUBLE_ELIMINATION' as any,
      formatName: 'Cup',
      format: null,
    });
    expect(out.format).toEqual({ system: 'DOUBLE_ELIMINATION', name: 'Cup' });
  });

  it('leaves the record untouched when there is no snapshot and no preset', () => {
    const t = { id: 't1' } as any;
    expect(withFormatSnapshot(t)).toBe(t);
  });

  it('keeps other keys on the preset it overlays', () => {
    const out = withFormatSnapshot({
      system: 'SWISS' as any,
      format: {
        id: 'f1',
        system: 'HYBRID' as any,
        name: 'House Hybrid',
      } as any,
    });
    expect(out.format).toMatchObject({
      id: 'f1',
      system: 'SWISS',
      name: 'House Hybrid',
    });
  });
});
