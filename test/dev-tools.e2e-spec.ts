import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { DevService } from '../src/dev/dev.service';
import { DevController } from '../src/dev/dev.controller';
import { TwoFactorService } from '../src/auth/two-factor.service';
import { TournamentService } from '../src/tournament/tournament.service';
import { JwtAuthGuard } from '../src/guards/jwt-auth.guard';
import { RolesGuard } from '../src/guards/roles.guard';
import { ROLES_KEY } from '../src/guards/decorators/roles.decorator';
import type { PrismaService } from 'prisma/prisma.service';

/**
 * The admin debug tools. Untested, which is backwards: these are the routes
 * that bypass the ordinary flow — they mint accounts in bulk, turn the second
 * factor off, and delete a tournament outright — so their *refusals* are the
 * whole safety story.
 */

const TOURNAMENT = 't1';

function harness(
  opts: { bulkGuests?: boolean; tournamentExists?: boolean } = {},
) {
  const deleted: string[] = [];
  const tx = {
    match: {
      updateMany: jest.fn(async () => ({ count: 0 })),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    round: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    tournamentParticipant: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    tournament: {
      delete: jest.fn(async ({ where }: any) => {
        deleted.push(where.id);
        return { id: where.id };
      }),
    },
  };

  const prisma = {
    tournament: {
      findUnique: jest.fn(async () =>
        opts.tournamentExists === false
          ? null
          : { id: TOURNAMENT, name: 'Winter Open' },
      ),
      // Read by the stats rebuild that follows a delete; no tournaments remain
      // in these tests, which is the interesting case anyway.
      findMany: jest.fn(async () => []),
    },
    // The rebuild wipes and recomputes both stats tables.
    userGameStats: {
      deleteMany: jest.fn(async () => ({ count: 0 })),
      createMany: jest.fn(async () => ({ count: 0 })),
    },
    userGlobalStats: {
      deleteMany: jest.fn(async () => ({ count: 0 })),
      createMany: jest.fn(async () => ({ count: 0 })),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };

  const joined: string[] = [];
  const participantService = {
    joinTournamentAsGuest: jest.fn(async (_t: string, name: string) => {
      joined.push(name);
      return { id: `g${joined.length}`, username: name };
    }),
  };

  const settings = {
    getBoolean: jest.fn(async () => opts.bulkGuests ?? true),
  };

  const svc = new DevService(
    prisma as unknown as PrismaService,
    participantService as any,
    {} as any,
    settings as any,
  );
  return { svc, prisma, tx, participantService, settings, joined, deleted };
}

describe('dev tools — the whole controller is ADMIN-only', () => {
  it('guards every route at the class, not per handler', () => {
    const guards =
      (Reflect.getMetadata('__guards__', DevController) as unknown[]) ?? [];
    const roles =
      (Reflect.getMetadata(ROLES_KEY, DevController) as Role[]) ?? [];
    expect(guards).toEqual(expect.arrayContaining([JwtAuthGuard, RolesGuard]));
    expect(roles).toEqual([Role.ADMIN]);
  });
});

describe('dev tools — bulk guest creation is gated', () => {
  it('refuses when "Allow Bulk Guest Creation" is off, naming where to turn it on', async () => {
    const h = harness({ bulkGuests: false });
    await expect(h.svc.batchAddGuests(TOURNAMENT, 5)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(h.svc.batchAddGuests(TOURNAMENT, 5)).rejects.toThrow(
      /Admin → Settings/,
    );
  });

  it('creates nobody when the gate is closed', async () => {
    const h = harness({ bulkGuests: false });
    await expect(h.svc.batchAddGuests(TOURNAMENT, 5)).rejects.toThrow();
    expect(h.participantService.joinTournamentAsGuest).not.toHaveBeenCalled();
  });

  it('checks the gate BEFORE the tournament exists — the switch is the outer rule', async () => {
    const h = harness({ bulkGuests: false, tournamentExists: false });
    await expect(h.svc.batchAddGuests(TOURNAMENT, 5)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(h.prisma.tournament.findUnique).not.toHaveBeenCalled();
  });

  it('adds the requested number when the gate is open', async () => {
    const h = harness({ bulkGuests: true });
    const res: any = await h.svc.batchAddGuests(TOURNAMENT, 3);
    expect(h.participantService.joinTournamentAsGuest).toHaveBeenCalledTimes(3);
    expect(res.results).toHaveLength(3);
    expect(res.message).toContain('3 guests');
  });

  it('uses the caller’s names, so there is one guest-name pool', async () => {
    // The pool lives in new/app/utils/guestName.ts. A second copy here would
    // drift from it, so the names come over the wire.
    const h = harness({ bulkGuests: true });
    await h.svc.batchAddGuests(TOURNAMENT, 2, ['Swift Falcon', 'Quiet Heron']);
    expect(h.joined).toEqual(['Swift Falcon', 'Quiet Heron']);
  });

  it('falls back to a readable name when one is missing or blank', async () => {
    const h = harness({ bulkGuests: true });
    await h.svc.batchAddGuests(TOURNAMENT, 3, ['Swift Falcon', '   ']);
    expect(h.joined[0]).toBe('Swift Falcon');
    // "Guest 4X9K" reads as a placeholder but still reads as a name.
    expect(h.joined[1]).toMatch(/^Guest [A-Z0-9]{4}$/);
    expect(h.joined[2]).toMatch(/^Guest [A-Z0-9]{4}$/);
  });

  it('404s for a tournament that does not exist', async () => {
    const h = harness({ bulkGuests: true, tournamentExists: false });
    await expect(h.svc.batchAddGuests(TOURNAMENT, 2)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.participantService.joinTournamentAsGuest).not.toHaveBeenCalled();
  });
});

describe('dev tools — the 2FA enforcement override', () => {
  const NODE_ENV = process.env.NODE_ENV;
  const ALLOW = process.env.ALLOW_2FA_BYPASS;

  afterEach(() => {
    process.env.NODE_ENV = NODE_ENV;
    if (ALLOW === undefined) delete process.env.ALLOW_2FA_BYPASS;
    else process.env.ALLOW_2FA_BYPASS = ALLOW;
    TwoFactorService.enforcementOverride = null;
  });

  it('sets the override in development', () => {
    process.env.NODE_ENV = 'development';
    const h = harness();
    const res = h.svc.setTwoFactorEnforcement('off', 'admin-1');
    expect(res.mode).toBe('off');
    expect(TwoFactorService.enforcementOverride).toBe('off');
  });

  it('is refused in production — a debug switch that works in prod is a backdoor', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_2FA_BYPASS;
    const h = harness();
    expect(() => h.svc.setTwoFactorEnforcement('off')).toThrow(
      ForbiddenException,
    );
    expect(TwoFactorService.enforcementOverride).toBeNull();
  });

  it('can be unlocked in production only by an explicit opt-in', () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_2FA_BYPASS = 'true';
    const h = harness();
    expect(() => h.svc.setTwoFactorEnforcement('staff')).not.toThrow();
    expect(TwoFactorService.enforcementOverride).toBe('staff');
  });

  it('treats any value but the literal "true" as locked', () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_2FA_BYPASS = '1';
    const h = harness();
    expect(() => h.svc.setTwoFactorEnforcement('off')).toThrow(
      ForbiddenException,
    );
  });

  it('reports the current override, and that it is in memory only', () => {
    process.env.NODE_ENV = 'development';
    const h = harness();
    expect(h.svc.getTwoFactorEnforcement()).toEqual({
      override: null,
      effective: 'configured',
    });
    h.svc.setTwoFactorEnforcement('off');
    expect(h.svc.getTwoFactorEnforcement()).toEqual({
      override: 'off',
      effective: 'off',
    });
  });
});

describe('dev tools — guest retention is not adjustable', () => {
  it('accepts only the fixed 30-day window', async () => {
    const h = harness();
    const res: any = await h.svc.setGuestExpiry(
      TournamentService.GUEST_EXPIRY_DAYS,
    );
    expect(res.current).toBe(30);
  });

  it('refuses any other value rather than silently ignoring it', async () => {
    // The endpoint survives for the admin panel, but retention is a policy, not
    // a knob — a UI that appeared to change it and did not would be worse.
    const h = harness();
    for (const days of [1, 7, 60, 0]) {
      await expect(h.svc.setGuestExpiry(days)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
  });
});

describe('dev tools — deleting a tournament outright', () => {
  it('404s for a tournament that does not exist', async () => {
    const h = harness({ tournamentExists: false });
    await expect(h.svc.deleteTournament(TOURNAMENT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('breaks the match-to-match links before deleting anything (F13)', async () => {
    // nextMatchId / loserNextMatchId are Restrict, so a match cannot be removed
    // while another still points at it.
    const h = harness();
    await h.svc.deleteTournament(TOURNAMENT);
    expect(h.tx.match.updateMany).toHaveBeenCalledWith({
      where: { round: { tournamentId: TOURNAMENT } },
      data: { nextMatchId: null, loserNextMatchId: null },
    });
    const unlinkOrder = h.tx.match.updateMany.mock.invocationCallOrder[0];
    const deleteOrder = h.tx.match.deleteMany.mock.invocationCallOrder[0];
    expect(unlinkOrder).toBeLessThan(deleteOrder);
  });

  it('deletes children before parents: matches, rounds, participants, tournament', async () => {
    const h = harness();
    await h.svc.deleteTournament(TOURNAMENT);
    const order = [
      h.tx.match.deleteMany.mock.invocationCallOrder[0],
      h.tx.round.deleteMany.mock.invocationCallOrder[0],
      h.tx.tournamentParticipant.deleteMany.mock.invocationCallOrder[0],
      h.tx.tournament.delete.mock.invocationCallOrder[0],
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(h.deleted).toEqual([TOURNAMENT]);
  });

  it('does all of it in one transaction, so a partial delete cannot strand the row', async () => {
    const h = harness();
    await h.svc.deleteTournament(TOURNAMENT);
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('rebuilds global stats afterwards, so no phantom wins survive the delete', async () => {
    // Lifetime counters are denormalized. Without this a deleted tournament
    // would leave its wins, losses and points on every player's record forever.
    const h = harness();
    await h.svc.deleteTournament(TOURNAMENT);
    expect(h.prisma.userGameStats.deleteMany).toHaveBeenCalled();
    expect(h.prisma.userGlobalStats.deleteMany).toHaveBeenCalled();
  });

  it('rebuilds only after the delete has committed', async () => {
    const h = harness();
    await h.svc.deleteTournament(TOURNAMENT);
    expect(h.prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
      h.prisma.userGlobalStats.deleteMany.mock.invocationCallOrder[0],
    );
  });

  it('does not rebuild when the tournament was never found', async () => {
    const h = harness({ tournamentExists: false });
    await expect(h.svc.deleteTournament(TOURNAMENT)).rejects.toThrow();
    expect(h.prisma.userGlobalStats.deleteMany).not.toHaveBeenCalled();
  });
});
