import {
  GUEST_RETENTION_DAYS,
  guestClaimProblem,
  guestDeadline,
  type GuestRecord,
} from './guest-lifecycle';

/**
 * A guest is a real result attached to a throwaway identity. These two functions
 * decide how long that identity can still be claimed by the person who earned
 * it — date arithmetic across four fallbacks, where being wrong in one direction
 * deletes somebody's tournament history and in the other never releases a name.
 *
 * `cleanGuests.spec` covers the job that acts on the deadline; nothing covered
 * how the deadline is computed.
 */

const DAY = 24 * 60 * 60 * 1000;
const RETENTION = GUEST_RETENTION_DAYS * DAY;
const NOW = new Date('2026-09-29T12:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

type Entry = {
  status: string;
  completedAt?: Date | null;
  guestCleanupAt?: Date | null;
};

function guest(
  entries: Entry[],
  over: {
    isGuest?: boolean;
    username?: string | null;
    expiresAt?: Date | null;
    createdAt?: Date;
  } = {},
): GuestRecord {
  return {
    id: 'guest-1',
    isGuest: over.isGuest ?? true,
    username: over.username === undefined ? 'Quiet Heron' : over.username,
    displayName: 'Quiet Heron',
    expiresAt: over.expiresAt ?? null,
    createdAt: over.createdAt ?? ago(1),
    participatedTournaments: entries.map((e, i) => ({
      placement: null,
      tournament: {
        id: `t${i}`,
        name: `Event ${i}`,
        status: e.status,
        completedAt: e.completedAt ?? null,
        guestCleanupAt: e.guestCleanupAt ?? null,
        winnerId: null,
        guestHistoryExclusions: [],
      },
    })),
  } as unknown as GuestRecord;
}

describe('guestDeadline', () => {
  it('is null while any event is unfinished — a live tournament never loses entrants', () => {
    for (const status of ['UPCOMING', 'OPEN', 'ONGOING']) {
      expect(guestDeadline(guest([{ status }]))).toBeNull();
    }
  });

  it('is null when one of several events is still running', () => {
    const g = guest([
      { status: 'COMPLETED', completedAt: ago(40) },
      { status: 'ONGOING' },
    ]);
    expect(guestDeadline(g)).toBeNull();
  });

  it('counts the retention window from completion', () => {
    const completedAt = ago(10);
    const deadline = guestDeadline(
      guest([{ status: 'COMPLETED', completedAt }]),
    );
    expect(deadline!.getTime()).toBe(completedAt.getTime() + RETENTION);
  });

  it('takes the EARLIEST deadline across several finished events', () => {
    // The window closes on the first one to expire, not the last.
    const early = ago(25);
    const late = ago(2);
    const deadline = guestDeadline(
      guest([
        { status: 'COMPLETED', completedAt: late },
        { status: 'COMPLETED', completedAt: early },
      ]),
    );
    expect(deadline!.getTime()).toBe(early.getTime() + RETENTION);
  });

  it('falls back to the tournament’s scheduled cleanup when completedAt is missing', () => {
    const cleanupAt = ago(3);
    const deadline = guestDeadline(
      guest([
        { status: 'COMPLETED', completedAt: null, guestCleanupAt: cleanupAt },
      ]),
    );
    expect(deadline!.getTime()).toBe(cleanupAt.getTime());
  });

  it('falls back to the guest’s own expiry when the tournament has neither', () => {
    const expiresAt = ago(4);
    const deadline = guestDeadline(
      guest([{ status: 'COMPLETED', completedAt: null }], { expiresAt }),
    );
    expect(deadline!.getTime()).toBe(expiresAt.getTime());
  });

  it('falls back to creation plus the retention window as a last resort', () => {
    const createdAt = ago(5);
    const deadline = guestDeadline(
      guest([{ status: 'COMPLETED', completedAt: null }], {
        expiresAt: null,
        createdAt,
      }),
    );
    expect(deadline!.getTime()).toBe(createdAt.getTime() + RETENTION);
  });

  it('uses the guest’s own expiry for a guest attached to no tournament at all', () => {
    const expiresAt = ago(2);
    expect(guestDeadline(guest([], { expiresAt }))!.getTime()).toBe(
      expiresAt.getTime(),
    );
  });

  it('uses creation plus retention for an unattached guest with no expiry', () => {
    const createdAt = ago(7);
    expect(
      guestDeadline(guest([], { expiresAt: null, createdAt }))!.getTime(),
    ).toBe(createdAt.getTime() + RETENTION);
  });
});

describe('guestClaimProblem', () => {
  it('permits a claim inside the window', () => {
    const g = guest([{ status: 'COMPLETED', completedAt: ago(5) }]);
    expect(guestClaimProblem(g, NOW)).toBeNull();
  });

  it('permits a claim while the event is still running', () => {
    expect(guestClaimProblem(guest([{ status: 'ONGOING' }]), NOW)).toBeNull();
  });

  it('refuses once the window has closed', () => {
    const g = guest([
      { status: 'COMPLETED', completedAt: ago(GUEST_RETENTION_DAYS + 1) },
    ]);
    expect(guestClaimProblem(g, NOW)).toMatch(/window has expired/i);
  });

  it('refuses exactly ON the deadline, not a moment after', () => {
    const completedAt = ago(GUEST_RETENTION_DAYS);
    const g = guest([{ status: 'COMPLETED', completedAt }]);
    expect(
      guestClaimProblem(g, new Date(completedAt.getTime() + RETENTION)),
    ).toMatch(/window has expired/i);
    expect(
      guestClaimProblem(g, new Date(completedAt.getTime() + RETENTION - 1)),
    ).toBeNull();
  });

  it('refuses for a record that is not a guest', () => {
    const g = guest([{ status: 'COMPLETED', completedAt: ago(1) }], {
      isGuest: false,
    });
    expect(guestClaimProblem(g, NOW)).toBe(
      'This player already has an account.',
    );
  });

  it('refuses once the handle has been released by retirement', () => {
    // retireGuest nulls `username` so a new user can take the name; the old
    // record must not be claimable afterwards.
    const g = guest([{ status: 'COMPLETED', completedAt: ago(1) }], {
      username: null,
    });
    expect(guestClaimProblem(g, NOW)).toMatch(/expired or been reassigned/i);
  });

  it('checks identity before the clock, so an expired non-guest reads correctly', () => {
    const g = guest([{ status: 'COMPLETED', completedAt: ago(90) }], {
      isGuest: false,
    });
    expect(guestClaimProblem(g, NOW)).toBe(
      'This player already has an account.',
    );
  });

  it('defaults `now` to the current time', () => {
    const fresh = guest([{ status: 'COMPLETED', completedAt: new Date() }]);
    expect(guestClaimProblem(fresh)).toBeNull();
  });
});
