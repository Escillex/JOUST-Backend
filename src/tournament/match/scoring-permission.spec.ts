import { ForbiddenException } from '@nestjs/common';
import {
  isParticipantOfMatch,
  resolveScoreActor,
} from './scoring-permission.helper';
import type { PrismaService } from 'prisma/prisma.service';
import type { JwtPayload } from '../../guards/jwt-auth.guard';

/**
 * Who may touch a match's score. The rule cannot live in a guard: it depends on
 * the tournament's `scoreSubmissionRule` AND on the caller's relation to this
 * specific match, neither of which a guard reads. `scoring-permission.e2e-spec`
 * covers the service paths; this covers the helper they all funnel through,
 * including the cases the e2e file does not construct — a caller with no token,
 * an unseated match, and a tournament that no longer exists.
 */

const P1 = 'player-1';
const P2 = 'player-2';
const CREATOR = 'creator-1';
const STRANGER = 'stranger-1';
const TOURNAMENT = 't1';

const user = (id: string, roles: string[] = ['PLAYER']): JwtPayload =>
  ({ id, email: null, username: id, roles }) as unknown as JwtPayload;

const match = (over: Partial<any> = {}) => ({
  player1Id: P1,
  player2Id: P2,
  round: { tournamentId: TOURNAMENT },
  ...over,
});

function prismaFor(
  opts: {
    /** `null` = the creator's account was deleted; the tournament remains. */
    creator?: string | null;
    /** The tournament row itself is gone. */
    missing?: boolean;
    acceptedOrganizerId?: string;
  } = {},
) {
  return {
    tournament: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.missing
            ? null
            : {
                createdById:
                  opts.creator === undefined ? CREATOR : opts.creator,
              },
        ),
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
  } as unknown as PrismaService;
}

describe('isParticipantOfMatch', () => {
  it('recognises either seat', () => {
    expect(isParticipantOfMatch(user(P1), match())).toBe(true);
    expect(isParticipantOfMatch(user(P2), match())).toBe(true);
  });

  it('rejects anyone else, including the tournament creator', () => {
    expect(isParticipantOfMatch(user(STRANGER), match())).toBe(false);
    expect(isParticipantOfMatch(user(CREATOR), match())).toBe(false);
  });

  it('rejects an unauthenticated caller', () => {
    expect(isParticipantOfMatch(null, match())).toBe(false);
    expect(isParticipantOfMatch(undefined, match())).toBe(false);
  });

  it('never matches an empty seat to a caller with no id', () => {
    // Both sides null would otherwise compare equal and hand a stranger the
    // match. Guests never authenticate, so an empty seat has no rightful caller.
    expect(
      isParticipantOfMatch(
        { id: '' } as JwtPayload,
        match({ player1Id: null, player2Id: null }),
      ),
    ).toBe(false);
    expect(
      isParticipantOfMatch(
        undefined as any,
        match({ player1Id: undefined, player2Id: undefined }),
      ),
    ).toBe(false);
  });

  it('still recognises the seated player when the other seat is empty', () => {
    expect(isParticipantOfMatch(user(P1), match({ player2Id: null }))).toBe(
      true,
    );
  });
});

describe('resolveScoreActor — participants', () => {
  it('returns PARTICIPANT under the permissive default', async () => {
    await expect(
      resolveScoreActor(prismaFor(), match(), user(P1), 'SELF_REPORT_ALLOWED'),
    ).resolves.toBe('PARTICIPANT');
  });

  it('refuses a participant under STAFF_ONLY, naming the reason', async () => {
    await expect(
      resolveScoreActor(prismaFor(), match(), user(P2), 'STAFF_ONLY'),
    ).rejects.toThrow('An organizer must submit scores in this tournament');
  });

  it('does not query the database to answer for a participant', async () => {
    // The seat comparison is enough, so the common path costs nothing.
    const prisma = prismaFor();
    await resolveScoreActor(prisma, match(), user(P1), 'SELF_REPORT_ALLOWED');
    expect((prisma as any).tournament.findUnique).not.toHaveBeenCalled();
  });

  it('prefers PARTICIPANT when the caller is both a player and staff', async () => {
    // An organizer playing in their own event scores their match as a player,
    // so a deciding game is still deferred for someone else to verify.
    const playingCreator = match({ player1Id: CREATOR });
    await expect(
      resolveScoreActor(
        prismaFor(),
        playingCreator,
        user(CREATOR),
        'SELF_REPORT_ALLOWED',
      ),
    ).resolves.toBe('PARTICIPANT');
  });

  it('refuses a playing organizer under STAFF_ONLY too', async () => {
    const playingCreator = match({ player1Id: CREATOR });
    await expect(
      resolveScoreActor(
        prismaFor(),
        playingCreator,
        user(CREATOR),
        'STAFF_ONLY',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('resolveScoreActor — staff', () => {
  it('returns STAFF for the tournament creator', async () => {
    await expect(
      resolveScoreActor(
        prismaFor(),
        match(),
        user(CREATOR),
        'SELF_REPORT_ALLOWED',
      ),
    ).resolves.toBe('STAFF');
  });

  it('returns STAFF for an ADMIN who has nothing to do with the tournament', async () => {
    await expect(
      resolveScoreActor(
        prismaFor(),
        match(),
        user(STRANGER, ['ADMIN']),
        'STAFF_ONLY',
      ),
    ).resolves.toBe('STAFF');
  });

  it('returns STAFF for an accepted co-organizer', async () => {
    await expect(
      resolveScoreActor(
        prismaFor({ acceptedOrganizerId: STRANGER }),
        match(),
        user(STRANGER),
        'STAFF_ONLY',
      ),
    ).resolves.toBe('STAFF');
  });

  it('grants nothing on a pending or declined invitation', async () => {
    const prisma = prismaFor();
    (prisma as any).tournamentOrganizer.findUnique.mockResolvedValue({
      status: 'PENDING',
    });
    await expect(
      resolveScoreActor(prisma, match(), user(STRANGER), 'STAFF_ONLY'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets staff act under either rule — STAFF_ONLY constrains players, not staff', async () => {
    for (const rule of ['STAFF_ONLY', 'SELF_REPORT_ALLOWED'] as const) {
      await expect(
        resolveScoreActor(prismaFor(), match(), user(CREATOR), rule),
      ).resolves.toBe('STAFF');
    }
  });
});

describe('resolveScoreActor — refusals', () => {
  const MESSAGE =
    'Only a player in this match or the tournament organizer can score this match';

  it('refuses a signed-in stranger', async () => {
    await expect(
      resolveScoreActor(
        prismaFor(),
        match(),
        user(STRANGER),
        'SELF_REPORT_ALLOWED',
      ),
    ).rejects.toThrow(MESSAGE);
  });

  it('refuses an unauthenticated caller', async () => {
    await expect(
      resolveScoreActor(prismaFor(), match(), null, 'SELF_REPORT_ALLOWED'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses when the match is not attached to a tournament', async () => {
    await expect(
      resolveScoreActor(
        prismaFor(),
        match({ round: null }),
        user(CREATOR),
        'STAFF_ONLY',
      ),
    ).rejects.toThrow(MESSAGE);
    await expect(
      resolveScoreActor(
        prismaFor(),
        match({ round: { tournamentId: null } }),
        user(CREATOR),
        'STAFF_ONLY',
      ),
    ).rejects.toThrow(MESSAGE);
  });

  it('refuses when the tournament no longer exists', async () => {
    // checkTournamentAccess reports NOT_FOUND; the helper must not read that
    // as permission.
    await expect(
      resolveScoreActor(
        prismaFor({ missing: true }),
        match(),
        user(CREATOR),
        'STAFF_ONLY',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses when the creator account was deleted and nobody owns the tournament', async () => {
    // A null createdById must not compare equal to anything; only the ADMIN
    // branch can reach an orphaned tournament.
    const orphaned = prismaFor({ creator: null });
    await expect(
      resolveScoreActor(
        orphaned,
        match(),
        user(STRANGER),
        'SELF_REPORT_ALLOWED',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      resolveScoreActor(
        orphaned,
        match(),
        user(STRANGER, ['ADMIN']),
        'STAFF_ONLY',
      ),
    ).resolves.toBe('STAFF');
  });
});
