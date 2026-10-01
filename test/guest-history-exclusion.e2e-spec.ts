import { NotFoundException } from '@nestjs/common';

/**
 * Guest history exclusion: "this tournament is not this person's, don't carry
 * it onto the account they're about to be given."
 *
 * There are two ways to say it and they mean different things. The list on the
 * conversion request is the registering organizer's one-time judgement. A
 * `GuestHistoryExclusion` row is a standing decision somebody already recorded,
 * with a reason and an audit entry — typically by the organizer who actually
 * ran the event, for a later colleague to honour.
 *
 * The second kind was written, reported to the client, fetched by
 * `convertGuest` — and then dropped on the floor, so the endpoint changed
 * nothing about the claim it existed to constrain. These tests hold both paths
 * to the same outcome.
 */

const GUEST = 'guest-1';
const ADMIN = 'admin-1';

function statsRow(over: Partial<any> = {}) {
  return { gamesPlayed: 4, wins: 3, losses: 1, draws: 0, points: 9, ...over };
}

/** A completed tournament the guest played in. */
function tournamentRow(id: string, opts: { excluded?: boolean; won?: boolean } = {}) {
  return {
    id,
    name: `Event ${id}`,
    status: 'COMPLETED',
    winnerId: opts.won ? GUEST : 'someone-else',
    completedAt: new Date('2026-09-01T00:00:00.000Z'),
    format: null,
    game: { name: 'Chess' },
    guestHistoryExclusions: opts.excluded ? [{ id: `x-${id}` }] : [],
    participants: [{ userId: GUEST, stats: statsRow() }],
  };
}

describe('excludeGuestTournament / restoreGuestTournament', () => {
  function harness(participations: string[] = ['t1', 't2']) {
    const upserts: any[] = [];
    const deletes: any[] = [];
    const prisma: any = {
      user: {
        findUnique: jest.fn(async () => ({
          id: GUEST,
          isGuest: true,
          username: 'quiet-heron',
          participatedTournaments: participations.map((id) => ({
            placement: null,
            tournament: { id, name: `Event ${id}`, status: 'COMPLETED', guestHistoryExclusions: [] },
          })),
        })),
      },
      guestHistoryExclusion: {
        upsert: jest.fn(async (args: any) => {
          upserts.push(args);
          return { id: 'x1' };
        }),
        deleteMany: jest.fn(async (args: any) => {
          deletes.push(args);
          return { count: 1 };
        }),
      },
    };
    const { AuthService } = require('../src/auth/auth.service');
    const svc: any = Object.create(AuthService.prototype);
    svc.prisma = prisma;
    return { svc, prisma, upserts, deletes };
  }

  it('records the exclusion against the guest and tournament pair', async () => {
    const h = harness();
    await h.svc.excludeGuestTournament(GUEST, 't1', ADMIN, { reason: 'Different player' });
    expect(h.upserts[0].where).toEqual({
      guestId_tournamentId: { guestId: GUEST, tournamentId: 't1' },
    });
    expect(h.upserts[0].create).toMatchObject({
      guestId: GUEST,
      tournamentId: 't1',
      excludedById: ADMIN,
      reason: 'Different player',
    });
  });

  it('records who made the call, so the audit entry has an author', async () => {
    const h = harness();
    await h.svc.excludeGuestTournament(GUEST, 't1', ADMIN, {});
    expect(h.upserts[0].create.excludedById).toBe(ADMIN);
  });

  it('is idempotent — excluding twice updates rather than duplicating', async () => {
    const h = harness();
    await h.svc.excludeGuestTournament(GUEST, 't1', ADMIN, { reason: 'First' });
    await h.svc.excludeGuestTournament(GUEST, 't1', ADMIN, { reason: 'Second' });
    expect(h.prisma.guestHistoryExclusion.upsert).toHaveBeenCalledTimes(2);
    expect(h.upserts[1].update).toMatchObject({ reason: 'Second' });
  });

  it('stores a blank reason as null rather than an empty string', async () => {
    const h = harness();
    await h.svc.excludeGuestTournament(GUEST, 't1', ADMIN, { reason: '   ' });
    expect(h.upserts[0].create.reason).toBeNull();
  });

  it('refuses for a record that is not a guest', async () => {
    const h = harness();
    h.prisma.user.findUnique.mockResolvedValue({ id: GUEST, isGuest: false, participatedTournaments: [] });
    await expect(
      h.svc.excludeGuestTournament(GUEST, 't1', ADMIN, {}),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a tournament the guest never played in', async () => {
    const h = harness(['t1']);
    await expect(
      h.svc.excludeGuestTournament(GUEST, 't9', ADMIN, {}),
    ).rejects.toThrow(/not attached to this guest record/);
    expect(h.prisma.guestHistoryExclusion.upsert).not.toHaveBeenCalled();
  });

  it('restoring removes the row for that pair only', async () => {
    const h = harness();
    await h.svc.restoreGuestTournament(GUEST, 't1');
    expect(h.deletes[0].where).toEqual({ guestId: GUEST, tournamentId: 't1' });
  });

  it('restoring something never excluded is harmless', async () => {
    const h = harness();
    await expect(h.svc.restoreGuestTournament(GUEST, 't2')).resolves.toBeDefined();
  });
});

describe('convertGuest honours a standing exclusion', () => {
  /** Drives the real `convertGuest`, returning the lifetime stats it wrote. */
  async function convert(
    tournaments: any[],
    dto: { excludedTournamentIds?: string[] } = {},
  ) {
    const guestRow = {
      id: GUEST,
      isGuest: true,
      username: 'quiet-heron',
      displayName: 'Quiet Heron',
      expiresAt: null,
      createdAt: new Date(),
      participatedTournaments: tournaments.map((t) => ({
        placement: t.participants[0]?.placement ?? null,
        tournament: {
          id: t.id,
          name: t.name,
          status: 'COMPLETED',
          completedAt: t.completedAt,
          guestCleanupAt: null,
          winnerId: t.winnerId,
          guestHistoryExclusions: [],
        },
      })),
    };

    let globalStats: any = null;
    const gameStats: any[] = [];

    const tx: any = {
      user: {
        findUnique: jest.fn(async () => guestRow),
        update: jest.fn(async () => ({ id: GUEST, username: 'claimed' })),
      },
      tournament: { findMany: jest.fn(async () => tournaments) },
      userGlobalStats: {
        upsert: jest.fn(async ({ create }: any) => {
          globalStats = create;
          return create;
        }),
      },
      userGameStats: {
        upsert: jest.fn(async ({ create }: any) => {
          gameStats.push(create);
          return create;
        }),
      },
    };

    const prisma: any = {
      user: {
        findUnique: jest.fn(async ({ where }: any) =>
          where?.slug ? null : guestRow,
        ),
        findFirst: jest.fn(async () => null),
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };

    const { AuthService } = require('../src/auth/auth.service');
    const svc: any = Object.create(AuthService.prototype);
    svc.prisma = prisma;
    svc.hashPassword = jest.fn(async () => 'hashed');

    await svc.convertGuest(GUEST, {
      username: 'quiet.heron',
      email: 'heron@example.com',
      password: 'password123',
      verifiedOwnership: true,
      ...dto,
    });

    return { globalStats, gameStats };
  }

  it('skips a tournament carrying a GuestHistoryExclusion row', async () => {
    const { globalStats } = await convert([
      tournamentRow('t1', { excluded: true }),
      tournamentRow('t2'),
    ]);
    // One tournament counted, not two.
    expect(globalStats.tournamentsPlayed).toBe(1);
    expect(globalStats.wins).toBe(3);
  });

  it('the two exclusion routes are a union, not alternatives', async () => {
    const { globalStats } = await convert(
      [
        tournamentRow('t1', { excluded: true }), // standing decision
        tournamentRow('t2'), // unticked on this form
        tournamentRow('t3'), // the only one kept
      ],
      { excludedTournamentIds: ['t2'] },
    );
    expect(globalStats.tournamentsPlayed).toBe(1);
  });

  it('a standing exclusion cannot be overridden by omitting it from the request', async () => {
    // The registering organizer sends no exclusions at all; the recorded one
    // still binds. This is the case that used to slip through.
    const { globalStats } = await convert(
      [tournamentRow('t1', { excluded: true }), tournamentRow('t2')],
      { excludedTournamentIds: [] },
    );
    expect(globalStats.tournamentsPlayed).toBe(1);
  });

  it('an excluded championship does not award tournamentsWon', async () => {
    const { globalStats } = await convert([
      tournamentRow('t1', { excluded: true, won: true }),
      tournamentRow('t2'),
    ]);
    expect(globalStats.tournamentsWon).toBe(0);
  });

  it('counts a championship that is NOT excluded', async () => {
    const { globalStats } = await convert([tournamentRow('t1', { won: true })]);
    expect(globalStats.tournamentsWon).toBe(1);
  });

  it('carries everything through when nothing is excluded', async () => {
    const { globalStats } = await convert([
      tournamentRow('t1'),
      tournamentRow('t2'),
    ]);
    expect(globalStats.tournamentsPlayed).toBe(2);
    expect(globalStats.wins).toBe(6);
    expect(globalStats.gamesPlayed).toBe(8);
  });

  it('keeps per-game stats in step with the exclusion', async () => {
    const { gameStats } = await convert([
      tournamentRow('t1', { excluded: true }),
      tournamentRow('t2'),
    ]);
    const chess = gameStats.find((g) => g.gameName === 'Chess');
    expect(chess.tournamentsPlayed).toBe(1);
  });
});

describe('the registry reports exclusions so they are visible before conversion', () => {
  it('flags each tournament and carries the reason', async () => {
    const prisma: any = {
      user: {
        findMany: jest.fn(async () => [
          {
            id: GUEST,
            username: 'quiet-heron',
            displayName: 'Quiet Heron',
            expiresAt: null,
            createdAt: new Date(),
            isGuest: true,
            participatedTournaments: [
              {
                placement: 2,
                tournament: {
                  id: 't1',
                  name: 'Winter Open',
                  status: 'COMPLETED',
                  completedAt: new Date('2026-09-01T00:00:00.000Z'),
                  guestCleanupAt: null,
                  winnerId: null,
                  guestHistoryExclusions: [
                    { id: 'x1', reason: 'Different player', createdAt: new Date() },
                  ],
                },
              },
            ],
          },
        ]),
      },
    };
    const { AuthService } = require('../src/auth/auth.service');
    const svc: any = Object.create(AuthService.prototype);
    svc.prisma = prisma;

    const { guests } = await svc.getGuestRegistry('');
    expect(guests[0].tournaments[0].excluded).toBe(true);
    expect(guests[0].tournaments[0].exclusion).toMatchObject({
      reason: 'Different player',
    });
  });
});
