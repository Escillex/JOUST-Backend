import { Prisma } from '@prisma/client';

/**
 * `AuthService.purgeExpiredGuests` — the entire guest retention policy, and
 * until now untested. `guest-lifecycle.spec.ts` covers the deadline
 * arithmetic and `cleanGuests.spec.ts` covers the cron delegating here; the
 * loop between them covered nothing.
 *
 * What it has to get right is mostly *restraint*: it runs unattended every
 * hour against every guest on the platform, and the failure it must never have
 * is retiring somebody early. Hence the double-check — the deadline is
 * recomputed inside a serializable transaction, so a guest who joined a new
 * tournament between the scan and the write keeps their handle.
 *
 * Retiring is not deleting. `retireGuest` releases the handle and clears the
 * credentials but keeps `displayName` and every event record, so a finished
 * bracket still reads correctly years later.
 */

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const ahead = (days: number) => new Date(Date.now() + days * DAY);

type GuestSpec = {
  id: string;
  username?: string | null;
  isGuest?: boolean;
  expiresAt?: Date | null;
  createdAt?: Date;
  tournaments?: {
    status: string;
    completedAt?: Date | null;
    guestCleanupAt?: Date | null;
  }[];
  /** Replaces the row seen *inside* the transaction, to model a race. */
  refetchAs?: Partial<GuestSpec>;
};

function row(spec: GuestSpec) {
  return {
    id: spec.id,
    isGuest: spec.isGuest ?? true,
    username: spec.username === undefined ? `guest-${spec.id}` : spec.username,
    displayName: 'Quiet Heron',
    expiresAt: spec.expiresAt ?? null,
    createdAt: spec.createdAt ?? ago(1),
    participatedTournaments: (spec.tournaments ?? []).map((t, i) => ({
      placement: null,
      tournament: {
        id: `t${i}`,
        name: `Event ${i}`,
        status: t.status,
        completedAt: t.completedAt ?? null,
        guestCleanupAt: t.guestCleanupAt ?? null,
        winnerId: null,
        guestHistoryExclusions: [],
      },
    })),
  };
}

/**
 * Builds the service with only the collaborators this method touches. The real
 * class has a large constructor, so it is created through `Object.create` and
 * given just `prisma` — the method under test uses nothing else.
 */
function harness(
  specs: GuestSpec[],
  opts: { txError?: (id: string) => unknown } = {},
) {
  const retired: string[] = [];
  const updates: any[] = [];

  const makeTx = (id: string) => ({
    user: {
      findUnique: jest.fn(async () => {
        const spec = specs.find((s) => s.id === id)!;
        return row({ ...spec, ...(spec.refetchAs ?? {}) });
      }),
      update: jest.fn(async ({ where, data }: any) => {
        retired.push(where.id);
        updates.push({ id: where.id, data });
        return { id: where.id };
      }),
    },
  });

  const prisma = {
    user: { findMany: jest.fn(async () => specs.map((s) => row(s))) },
    $transaction: jest.fn(async (fn: any, options: any) => {
      // The id being processed is whichever guest this call is for; the loop
      // runs them in order, so track by call index.
      const idx = prisma.$transaction.mock.calls.length - 1;
      const id = dueOrder[idx];
      if (opts.txError) {
        const err = opts.txError(id);
        if (err) throw err;
      }
      return fn(makeTx(id));
    }),
  } as any;

  // Which guests the loop will actually open a transaction for, in order.
  const dueOrder: string[] = [];

  const { AuthService } = require('../src/auth/auth.service');
  const svc: any = Object.create(AuthService.prototype);
  svc.prisma = prisma;
  // `Object.create` skips field initialisers, so the instance logger is stubbed
  // here. Captured rather than silenced: an unexpected failure must be reported,
  // not swallowed.
  const logged: string[] = [];
  svc.logger = {
    error: (m: string) => logged.push(m),
    warn: jest.fn(),
    log: jest.fn(),
  };

  return { svc, prisma, retired, updates, dueOrder, logged };
}

/** Runs the purge, first computing which guests are due so the tx mock can
 *  attribute each call to a guest. */
async function purge(
  specs: GuestSpec[],
  opts: { txError?: (id: string) => unknown } = {},
) {
  const { guestDeadline } = require('../src/user/guest-lifecycle');
  const h = harness(specs, opts);
  for (const s of specs) {
    const d = guestDeadline(row(s));
    if (d && d <= new Date()) h.dueOrder.push(s.id);
  }
  await h.svc.purgeExpiredGuests();
  return h;
}

describe('purgeExpiredGuests — who it scans', () => {
  it('asks only for guests that still hold a handle', async () => {
    const h = await purge([]);
    expect(h.prisma.user.findMany.mock.calls[0][0].where).toEqual({
      isGuest: true,
      username: { not: null },
    });
  });

  it('loads each guest’s tournament history, which the deadline depends on', async () => {
    const h = await purge([]);
    expect(h.prisma.user.findMany.mock.calls[0][0].include).toBeDefined();
  });
});

describe('purgeExpiredGuests — who it leaves alone', () => {
  it('skips a guest still in an unfinished tournament', async () => {
    // guestDeadline returns null: a live event never loses entrants.
    for (const status of ['UPCOMING', 'OPEN', 'ONGOING']) {
      const h = await purge([{ id: 'g1', tournaments: [{ status }] }]);
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
      expect(h.retired).toEqual([]);
    }
  });

  it('skips a guest whose window has not closed yet', async () => {
    const h = await purge([
      { id: 'g1', tournaments: [{ status: 'COMPLETED', completedAt: ago(5) }] },
    ]);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('skips a guest one instant before the deadline', async () => {
    const h = await purge([{ id: 'g1', expiresAt: ahead(0.001) }]);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('opens no transaction at all when nothing is due — the common hourly tick', async () => {
    const h = await purge([
      { id: 'g1', tournaments: [{ status: 'ONGOING' }] },
      { id: 'g2', expiresAt: ahead(10) },
    ]);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('purgeExpiredGuests — who it retires', () => {
  it('retires a guest whose 30 days have run out', async () => {
    const h = await purge([
      {
        id: 'g1',
        tournaments: [{ status: 'COMPLETED', completedAt: ago(31) }],
      },
    ]);
    expect(h.retired).toEqual(['g1']);
  });

  it('releases the handle but keeps the person on the record', async () => {
    const h = await purge([{ id: 'g1', expiresAt: ago(1) }]);
    const { data } = h.updates[0];
    // Released for reuse:
    expect(data.username).toBeNull();
    expect(data.slug).toBeNull();
    // Unclaimable:
    expect(data.email).toBeNull();
    expect(data.hashedPassword).toBeNull();
    expect(data.isExpired).toBe(true);
    // Still a person in every bracket they played:
    expect(data.displayName).toBe('Quiet Heron');
  });

  it('retires champions too — one policy, no exception for the winner', async () => {
    const h = await purge([
      {
        id: 'champ',
        tournaments: [{ status: 'COMPLETED', completedAt: ago(40) }],
      },
    ]);
    expect(h.retired).toEqual(['champ']);
  });

  it('processes every due guest, not just the first', async () => {
    const h = await purge([
      { id: 'g1', expiresAt: ago(1) },
      { id: 'g2', expiresAt: ago(2) },
      { id: 'g3', expiresAt: ago(3) },
    ]);
    expect(h.retired).toEqual(['g1', 'g2', 'g3']);
  });

  it('retires each guest in its own serializable transaction', async () => {
    const h = await purge([
      { id: 'g1', expiresAt: ago(1) },
      { id: 'g2', expiresAt: ago(2) },
    ]);
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(2);
    for (const call of h.prisma.$transaction.mock.calls) {
      expect(call[1]).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    }
  });
});

describe('purgeExpiredGuests — the race guard', () => {
  // The deadline is recomputed inside the transaction, so anything that
  // happened since the scan wins. This is the check that stops the job
  // retiring somebody who just re-entered a tournament.
  it('does not retire a guest who joined a live tournament since the scan', async () => {
    const h = await purge([
      {
        id: 'g1',
        expiresAt: ago(1),
        refetchAs: { tournaments: [{ status: 'ONGOING' }] },
      },
    ]);
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(h.retired).toEqual([]);
  });

  it('does not retire a guest who was claimed since the scan', async () => {
    const h = await purge([
      { id: 'g1', expiresAt: ago(1), refetchAs: { isGuest: false } },
    ]);
    expect(h.retired).toEqual([]);
  });

  it('does not retire a guest whose handle was already released', async () => {
    const h = await purge([
      { id: 'g1', expiresAt: ago(1), refetchAs: { username: null } },
    ]);
    expect(h.retired).toEqual([]);
  });

  it('does not retire a guest whose deadline moved into the future', async () => {
    const h = await purge([
      { id: 'g1', expiresAt: ago(1), refetchAs: { expiresAt: ahead(10) } },
    ]);
    expect(h.retired).toEqual([]);
  });
});

describe('purgeExpiredGuests — failure handling', () => {
  const serializationFailure = () =>
    new Prisma.PrismaClientKnownRequestError('write conflict', {
      code: 'P2034',
      clientVersion: 'test',
    });

  it('tolerates a serialization conflict and carries on with the next guest', async () => {
    // A concurrent registration won the row; retrying next hour is correct.
    const h = await purge(
      [
        { id: 'g1', expiresAt: ago(1) },
        { id: 'g2', expiresAt: ago(2) },
      ],
      { txError: (id) => (id === 'g1' ? serializationFailure() : null) },
    );
    expect(h.retired).toEqual(['g2']);
  });

  it('survives a pass where every guest conflicts', async () => {
    const h = await purge(
      [
        { id: 'g1', expiresAt: ago(1) },
        { id: 'g2', expiresAt: ago(2) },
      ],
      { txError: () => serializationFailure() },
    );
    expect(h.retired).toEqual([]);
  });

  it('keeps going after an unexpected failure instead of abandoning the pass', async () => {
    // Previously any non-P2034 error was rethrown, so one bad row stopped every
    // remaining guest for that hour and surfaced as an unhandled rejection from
    // the cron. A retention job must not be stoppable by a single record.
    const h = await purge(
      [
        { id: 'g1', expiresAt: ago(1) },
        { id: 'g2', expiresAt: ago(2) },
        { id: 'g3', expiresAt: ago(3) },
      ],
      {
        txError: (id) => (id === 'g1' ? new Error('deadlock detected') : null),
      },
    );
    expect(h.retired).toEqual(['g2', 'g3']);
  });

  it('reports the guest it could not retire, rather than failing silently', async () => {
    const h = await purge([{ id: 'g1', expiresAt: ago(1) }], {
      txError: () => new Error('deadlock detected'),
    });
    expect(h.logged).toHaveLength(1);
    expect(h.logged[0]).toContain('g1');
    expect(h.logged[0]).toContain('deadlock detected');
  });

  it('never rejects, so the hourly cron cannot raise an unhandled rejection', async () => {
    await expect(
      purge([{ id: 'g1', expiresAt: ago(1) }], {
        txError: () => new Error('connection lost'),
      }),
    ).resolves.toBeDefined();
  });

  it('logs nothing on a clean pass', async () => {
    const h = await purge([{ id: 'g1', expiresAt: ago(1) }]);
    expect(h.retired).toEqual(['g1']);
    expect(h.logged).toEqual([]);
  });
});
