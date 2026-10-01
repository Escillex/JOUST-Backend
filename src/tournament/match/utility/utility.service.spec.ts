import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MatchUtilityService } from './utility.service';
import type { PrismaService } from 'prisma/prisma.service';
import type { RealtimeGateway } from '../../../realtime/realtime.gateway';
import type { JwtPayload } from '../../../guards/jwt-auth.guard';

/**
 * The shared coin / dice / timer panel. It had no tests at all, which matters
 * more than it looks: `utilities.*` is a real server-side gate, not a UI hint
 * (Core Rule 9), and the permission it enforces is read from the tournament's
 * config rather than from a role — so a guard cannot express it and only this
 * service decides.
 *
 * Coin flips are server-generated on purpose. A client-side flip is a client
 * that can flip until it likes the answer.
 */

const TOURNAMENT = 't1';
const MATCH = 'm1';
const P1 = 'player-1';
const P2 = 'player-2';
const CREATOR = 'creator-1';
const STRANGER = 'stranger-1';

const user = (id: string, roles: string[] = ['PLAYER']): JwtPayload =>
  ({ id, email: null, username: id, roles }) as unknown as JwtPayload;

type Harness = {
  service: MatchUtilityService;
  prisma: any;
  realtime: { emitUtilityUpdate: jest.Mock };
  upserted: () => any;
};

/** A match in a tournament created by CREATOR, with `config` as its rules. */
function harness(
  config: Record<string, unknown> | null = {},
  utilityState: Record<string, unknown> | null = null,
  opts: { acceptedOrganizerId?: string } = {},
): Harness {
  let lastUpsert: any = null;

  const prisma = {
    match: {
      findUnique: jest.fn().mockResolvedValue({
        id: MATCH,
        player1Id: P1,
        player2Id: P2,
        round: {
          tournament: {
            id: TOURNAMENT,
            config,
            format: { config: null },
          },
        },
        utilityState,
      }),
    },
    matchUtilityState: {
      upsert: jest.fn().mockImplementation(({ create, update }: any) => {
        lastUpsert = { ...(utilityState ?? {}), ...(create ?? update) };
        return Promise.resolve({
          timerDurationSec: null,
          timerEndsAt: null,
          timerRunning: false,
          timerPausedRemainingSec: null,
          flips: null,
          ...lastUpsert,
        });
      }),
    },
    // Consumed by checkTournamentAccess.
    tournament: {
      findUnique: jest.fn().mockResolvedValue({ createdById: CREATOR }),
    },
    tournamentOrganizer: {
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(
            opts.acceptedOrganizerId &&
              where.tournamentId_userId.userId === opts.acceptedOrganizerId
              ? { status: 'ACCEPTED' }
              : null,
          ),
        ),
    },
  };

  const realtime = { emitUtilityUpdate: jest.fn() };

  return {
    service: new MatchUtilityService(
      prisma as unknown as PrismaService,
      realtime as unknown as RealtimeGateway,
    ),
    prisma,
    realtime,
    upserted: () => lastUpsert,
  };
}

describe('MatchUtilityService — loading a match', () => {
  it('404s for a match that does not exist', async () => {
    const h = harness();
    h.prisma.match.findUnique.mockResolvedValue(null);
    await expect(h.service.getState(MATCH)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s for a match with no tournament rather than reading a null config', async () => {
    const h = harness();
    h.prisma.match.findUnique.mockResolvedValue({
      id: MATCH,
      player1Id: P1,
      player2Id: P2,
      round: null,
      utilityState: null,
    });
    await expect(h.service.getState(MATCH)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('MatchUtilityService.getState', () => {
  it('is readable without auth, like the tracker GET — spectators see the timer', async () => {
    const h = harness(
      {},
      {
        timerDurationSec: 300,
        timerEndsAt: new Date('2026-09-29T10:00:00.000Z'),
        timerRunning: true,
        timerPausedRemainingSec: null,
        flips: { [P1]: { kind: 'COIN', result: 'Heads', at: 'now' } },
      },
    );
    const state = await h.service.getState(MATCH);
    expect(state.matchId).toBe(MATCH);
    expect(state.timer).toEqual({
      durationSec: 300,
      endsAt: '2026-09-29T10:00:00.000Z',
      running: true,
      pausedRemainingSec: null,
    });
    expect(state.flips[P1].result).toBe('Heads');
  });

  it('serialises an absent row as an idle timer with no flips', async () => {
    const state = await harness().service.getState(MATCH);
    expect(state.timer).toEqual({
      durationSec: null,
      endsAt: null,
      running: false,
      pausedRemainingSec: null,
    });
    expect(state.flips).toEqual({});
  });

  it('ships the resolved permissions so the client knows which triggers to draw', async () => {
    const state = await harness({ utilityTimerWho: 'NONE' }).service.getState(
      MATCH,
    );
    expect(state.perms).toEqual({
      enabled: true,
      coinWho: 'STAFF_AND_PARTICIPANTS',
      diceWho: 'STAFF_AND_PARTICIPANTS',
      timerWho: 'NONE',
    });
  });

  it('tolerates a corrupt flips blob instead of throwing', async () => {
    const h = harness(
      {},
      {
        timerDurationSec: null,
        timerEndsAt: null,
        timerRunning: false,
        timerPausedRemainingSec: null,
        flips: 'not-an-object',
      },
    );
    expect((await h.service.getState(MATCH)).flips).toEqual({});
  });
});

describe('MatchUtilityService — the master switch', () => {
  it('refuses every action when utilities are disabled', async () => {
    const h = harness({ utilitiesEnabled: false });
    await expect(h.service.flipCoin(MATCH, user(P1))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      h.service.rollDice(MATCH, {}, user(P1)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      h.service.timer(MATCH, { action: 'reset' }, user(CREATOR)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('still lets anyone READ the state — the switch hides the controls, not the match', async () => {
    const state = await harness({ utilitiesEnabled: false }).service.getState(
      MATCH,
    );
    expect(state.perms.enabled).toBe(false);
  });
});

describe('MatchUtilityService — the permission matrix', () => {
  // perm × caller. The caller is one of: a player of this match, the
  // tournament's creator (staff), an accepted co-organizer (staff), a stranger.
  const cases: [string, string, boolean][] = [
    ['NONE', P1, false],
    ['NONE', CREATOR, false],
    ['STAFF', P1, false],
    ['STAFF', CREATOR, true],
    ['STAFF', STRANGER, false],
    ['PARTICIPANTS', P1, true],
    ['PARTICIPANTS', P2, true],
    ['PARTICIPANTS', CREATOR, false],
    ['PARTICIPANTS', STRANGER, false],
    ['STAFF_AND_PARTICIPANTS', P1, true],
    ['STAFF_AND_PARTICIPANTS', CREATOR, true],
    ['STAFF_AND_PARTICIPANTS', STRANGER, false],
  ];

  it.each(cases)('coinWho=%s: %s is %s', async (perm, caller, allowed) => {
    const h = harness({ utilityCoinWho: perm });
    const attempt = h.service.flipCoin(MATCH, user(caller));
    if (allowed) {
      await expect(attempt).resolves.toBeDefined();
    } else {
      await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('counts an ADMIN as staff', async () => {
    const h = harness({ utilityCoinWho: 'STAFF' });
    await expect(
      h.service.flipCoin(MATCH, user(STRANGER, ['ADMIN'])),
    ).resolves.toBeDefined();
  });

  it('counts an accepted co-organizer as staff', async () => {
    const h = harness({ utilityCoinWho: 'STAFF' }, null, {
      acceptedOrganizerId: STRANGER,
    });
    await expect(
      h.service.flipCoin(MATCH, user(STRANGER)),
    ).resolves.toBeDefined();
  });

  it('reads each utility from its own permission, not a shared one', async () => {
    const h = harness({
      utilityCoinWho: 'PARTICIPANTS',
      utilityDiceWho: 'STAFF',
      utilityTimerWho: 'NONE',
    });
    await expect(h.service.flipCoin(MATCH, user(P1))).resolves.toBeDefined();
    await expect(
      h.service.rollDice(MATCH, {}, user(P1)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      h.service.timer(MATCH, { action: 'reset' }, user(CREATOR)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('MatchUtilityService.flipCoin', () => {
  it('produces Heads or Tails, server-side', async () => {
    for (let i = 0; i < 40; i++) {
      const h = harness();
      const state = await h.service.flipCoin(MATCH, user(P1));
      expect(['Heads', 'Tails']).toContain(state.flips[P1].result);
      expect(state.flips[P1].kind).toBe('COIN');
    }
  });

  it('can produce both faces', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200 && seen.size < 2; i++) {
      const h = harness();
      seen.add((await h.service.flipCoin(MATCH, user(P1))).flips[P1].result);
    }
    expect(seen).toEqual(new Set(['Heads', 'Tails']));
  });

  it('keys the result by the caller, so each player keeps their own flip', async () => {
    const h = harness(
      {},
      {
        timerDurationSec: null,
        timerEndsAt: null,
        timerRunning: false,
        timerPausedRemainingSec: null,
        flips: { [P2]: { kind: 'DICE', result: '4', at: 'earlier' } },
      },
    );
    const state = await h.service.flipCoin(MATCH, user(P1));
    expect(Object.keys(state.flips).sort()).toEqual([P1, P2].sort());
    expect(state.flips[P2].result).toBe('4');
  });

  it('replaces the caller’s previous flip rather than appending', async () => {
    const h = harness(
      {},
      {
        timerDurationSec: null,
        timerEndsAt: null,
        timerRunning: false,
        timerPausedRemainingSec: null,
        flips: { [P1]: { kind: 'DICE', result: '1', at: 'earlier' } },
      },
    );
    const state = await h.service.flipCoin(MATCH, user(P1));
    expect(state.flips[P1].kind).toBe('COIN');
    expect(Object.keys(state.flips)).toEqual([P1]);
  });

  it('broadcasts to the tournament room so both tables see the same flip', async () => {
    const h = harness();
    const state = await h.service.flipCoin(MATCH, user(P1));
    expect(h.realtime.emitUtilityUpdate).toHaveBeenCalledTimes(1);
    expect(h.realtime.emitUtilityUpdate).toHaveBeenCalledWith(TOURNAMENT, {
      matchId: MATCH,
      state,
    });
  });

  it('does not broadcast when the caller was refused', async () => {
    const h = harness({ utilityCoinWho: 'NONE' });
    await expect(h.service.flipCoin(MATCH, user(P1))).rejects.toThrow();
    expect(h.realtime.emitUtilityUpdate).not.toHaveBeenCalled();
    expect(h.prisma.matchUtilityState.upsert).not.toHaveBeenCalled();
  });
});

describe('MatchUtilityService.rollDice', () => {
  it('defaults to one six-sided die', async () => {
    for (let i = 0; i < 40; i++) {
      const h = harness();
      const result = (await h.service.rollDice(MATCH, {}, user(P1))).flips[P1]
        .result;
      expect(result).toMatch(/^[1-6]$/);
    }
  });

  it('rolls `count` dice of `sides` and joins them for display', async () => {
    const h = harness();
    const result = (
      await h.service.rollDice(MATCH, { sides: 20, count: 3 }, user(P1))
    ).flips[P1].result;
    const values = result.split(', ').map(Number);
    expect(values).toHaveLength(3);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(20);
    }
  });

  it('can produce both extremes of a d2, so the range is inclusive', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200 && seen.size < 2; i++) {
      const h = harness();
      seen.add(
        (await h.service.rollDice(MATCH, { sides: 2 }, user(P1))).flips[P1]
          .result,
      );
    }
    expect(seen).toEqual(new Set(['1', '2']));
  });
});

describe('MatchUtilityService.timer', () => {
  const staff = user(CREATOR);
  const idle = {
    timerDurationSec: null,
    timerEndsAt: null,
    timerRunning: false,
    timerPausedRemainingSec: null,
    flips: null,
  };

  it('set: holds the duration without starting the clock', async () => {
    const h = harness();
    const state = await h.service.timer(
      MATCH,
      { action: 'set', durationSec: 300 },
      staff,
    );
    expect(h.upserted()).toMatchObject({
      timerDurationSec: 300,
      timerPausedRemainingSec: 300,
      timerEndsAt: null,
      timerRunning: false,
      timerNotified: false,
    });
    expect(state.timer.running).toBe(false);
  });

  it('set: refuses without a duration', async () => {
    const h = harness();
    await expect(
      h.service.timer(MATCH, { action: 'set' }, staff),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('start: refuses when no duration has ever been set', async () => {
    const h = harness();
    await expect(
      h.service.timer(MATCH, { action: 'start' }, staff),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('start: sets an absolute end time, so every viewer counts down to the same instant', async () => {
    const h = harness(
      {},
      { ...idle, timerDurationSec: 300, timerPausedRemainingSec: 300 },
    );
    const before = Date.now();
    await h.service.timer(MATCH, { action: 'start' }, staff);
    const endsAt = (h.upserted().timerEndsAt as Date).getTime();
    expect(endsAt).toBeGreaterThanOrEqual(before + 300_000);
    expect(endsAt).toBeLessThanOrEqual(Date.now() + 300_000);
    expect(h.upserted()).toMatchObject({
      timerRunning: true,
      timerPausedRemainingSec: null,
      timerNotified: false,
    });
  });

  it('start: resumes from the paused remainder, not from the full duration', async () => {
    const h = harness(
      {},
      { ...idle, timerDurationSec: 300, timerPausedRemainingSec: 42 },
    );
    const before = Date.now();
    await h.service.timer(MATCH, { action: 'start' }, staff);
    const endsAt = (h.upserted().timerEndsAt as Date).getTime();
    expect(endsAt).toBeLessThanOrEqual(Date.now() + 42_000);
    expect(endsAt).toBeGreaterThanOrEqual(before + 42_000);
    // The configured duration survives, so `reset` still returns to 300.
    expect(h.upserted().timerDurationSec).toBe(300);
  });

  it('start: a supplied duration sets and starts in one call', async () => {
    const h = harness(
      {},
      { ...idle, timerDurationSec: 300, timerPausedRemainingSec: 42 },
    );
    await h.service.timer(MATCH, { action: 'start', durationSec: 60 }, staff);
    expect(h.upserted().timerDurationSec).toBe(60);
    expect((h.upserted().timerEndsAt as Date).getTime()).toBeLessThanOrEqual(
      Date.now() + 60_000,
    );
  });

  it('pause: freezes the remaining seconds and drops the end time', async () => {
    const h = harness(
      {},
      {
        ...idle,
        timerDurationSec: 300,
        timerEndsAt: new Date(Date.now() + 90_000),
        timerRunning: true,
      },
    );
    await h.service.timer(MATCH, { action: 'pause' }, staff);
    expect(h.upserted().timerRunning).toBe(false);
    expect(h.upserted().timerEndsAt).toBeNull();
    expect(h.upserted().timerPausedRemainingSec).toBeGreaterThanOrEqual(89);
    expect(h.upserted().timerPausedRemainingSec).toBeLessThanOrEqual(90);
  });

  it('pause: never records negative time for an expired timer', async () => {
    const h = harness(
      {},
      {
        ...idle,
        timerDurationSec: 300,
        timerEndsAt: new Date(Date.now() - 30_000),
        timerRunning: true,
      },
    );
    await h.service.timer(MATCH, { action: 'pause' }, staff);
    expect(h.upserted().timerPausedRemainingSec).toBe(0);
  });

  it('pause: on an already-paused timer keeps the held remainder', async () => {
    const h = harness(
      {},
      { ...idle, timerDurationSec: 300, timerPausedRemainingSec: 42 },
    );
    await h.service.timer(MATCH, { action: 'pause' }, staff);
    expect(h.upserted().timerPausedRemainingSec).toBe(42);
  });

  it('reset: returns to the configured duration, stopped', async () => {
    const h = harness(
      {},
      {
        ...idle,
        timerDurationSec: 300,
        timerEndsAt: new Date(Date.now() + 10_000),
        timerRunning: true,
      },
    );
    await h.service.timer(MATCH, { action: 'reset' }, staff);
    expect(h.upserted()).toMatchObject({
      timerRunning: false,
      timerEndsAt: null,
      timerPausedRemainingSec: 300,
      timerNotified: false,
    });
  });

  it('reset: on a timer that was never set leaves it empty', async () => {
    const h = harness();
    await h.service.timer(MATCH, { action: 'reset' }, staff);
    expect(h.upserted().timerPausedRemainingSec).toBeNull();
  });

  it('is staff-only by default — a player cannot control the clock', async () => {
    const h = harness();
    await expect(
      h.service.timer(MATCH, { action: 'set', durationSec: 300 }, user(P1)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('broadcasts every accepted timer change', async () => {
    const h = harness();
    await h.service.timer(MATCH, { action: 'set', durationSec: 300 }, staff);
    expect(h.realtime.emitUtilityUpdate).toHaveBeenCalledWith(
      TOURNAMENT,
      expect.objectContaining({ matchId: MATCH }),
    );
  });
});

describe('MatchUtilityService — config source', () => {
  it('reads the tournament override ahead of the preset', async () => {
    const h = harness();
    h.prisma.match.findUnique.mockResolvedValue({
      id: MATCH,
      player1Id: P1,
      player2Id: P2,
      round: {
        tournament: {
          id: TOURNAMENT,
          config: { utilityCoinWho: 'NONE' },
          format: { config: { utilityCoinWho: 'STAFF_AND_PARTICIPANTS' } },
        },
      },
      utilityState: null,
    });
    await expect(h.service.flipCoin(MATCH, user(P1))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('falls back to the preset when the tournament has no override', async () => {
    const h = harness();
    h.prisma.match.findUnique.mockResolvedValue({
      id: MATCH,
      player1Id: P1,
      player2Id: P2,
      round: {
        tournament: {
          id: TOURNAMENT,
          config: null,
          format: { config: { utilityCoinWho: 'NONE' } },
        },
      },
      utilityState: null,
    });
    await expect(h.service.flipCoin(MATCH, user(P1))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
