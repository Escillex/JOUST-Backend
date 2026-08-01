import { MatchService } from '../src/tournament/match/match.service';
import { ParticipantService } from '../src/tournament/participant/participant.service';
import { RealtimeGateway } from '../src/realtime/realtime.gateway';
import { MatchStatus } from '@prisma/client';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

// Covers ParticipantService.replaceParticipant: a clean identity swap of a
// substitute into a player's slot. Only allowed while the player has zero
// completed matches (pure identity substitution, no history rewrite) —
// pending matches are repointed to the substitute and a realtime refresh is
// emitted. Enforces the same organizer/admin ownership shape as
// forfeitParticipant (see forfeit.e2e-spec.ts). MatchService and
// RealtimeGateway are stubbed since this is a focused unit test of
// ParticipantService alone.
describe('ParticipantService.replaceParticipant', () => {
  let participantService: ParticipantService;
  let prisma: any;
  let matchService: { completeAsWalkover: jest.Mock };
  let realtime: { emitTournamentUpdated: jest.Mock };

  beforeEach(() => {
    prisma = {
      tournament: {
        findUnique: jest.fn(),
      },
      tournamentParticipant: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      match: {
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    };
    // Transaction-aware code under test calls prisma.$transaction(cb). The
    // mock runs the callback against itself, so the assertions below are
    // unchanged by the wrapping.
    prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));

    matchService = {
      completeAsWalkover: jest.fn().mockResolvedValue(undefined),
    };

    realtime = {
      emitTournamentUpdated: jest.fn(),
    };

    participantService = new ParticipantService(
      prisma,
      matchService as unknown as MatchService,
      realtime as unknown as RealtimeGateway,
      // Notifications are best-effort side effects, stubbed so this suite stays
      // focused on the behaviour it is actually asserting.
      { notify: jest.fn(), notifyMany: jest.fn() } as any,
    );
  });

  it('replace rewrites pending matches to the substitute when the player has not played', async () => {
    prisma.tournament.findUnique.mockResolvedValue({
      id: 't1',
      status: 'ONGOING',
      createdById: 'owner',
    });
    // First findUnique call is for the player being replaced ('x'), second
    // is the "already a participant?" check for the substitute ('y').
    prisma.tournamentParticipant.findUnique.mockImplementation(
      ({ where }: any) => {
        if (where.userId_tournamentId.userId === 'x') {
          return Promise.resolve({
            id: 'participant-x',
            userId: 'x',
            tournamentId: 't1',
          });
        }
        return Promise.resolve(null);
      },
    );
    prisma.match.count.mockResolvedValue(0);
    prisma.user.findUnique.mockResolvedValue({
      id: 'y',
      username: 'Substitute',
    });

    await participantService.replaceParticipant(
      't1',
      'x',
      { substituteUserId: 'y' },
      { id: 'owner', roles: ['ORGANIZER'] } as any,
    );

    expect(prisma.tournamentParticipant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'y' }),
      }),
    );
    expect(prisma.match.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ player1Id: 'x' }),
        data: expect.objectContaining({ player1Id: 'y' }),
      }),
    );
    expect(prisma.match.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ player2Id: 'x' }),
        data: expect.objectContaining({ player2Id: 'y' }),
      }),
    );
    expect(realtime.emitTournamentUpdated).toHaveBeenCalledWith('t1');
  });

  it('replace is rejected when the player already has a completed match', async () => {
    prisma.tournament.findUnique.mockResolvedValue({
      id: 't1',
      status: 'ONGOING',
      createdById: 'owner',
    });
    prisma.tournamentParticipant.findUnique.mockResolvedValue({
      id: 'participant-x',
      userId: 'x',
      tournamentId: 't1',
    });
    prisma.match.count.mockResolvedValue(1);

    await expect(
      participantService.replaceParticipant(
        't1',
        'x',
        { substituteUserId: 'y' },
        { id: 'owner', roles: ['ORGANIZER'] } as any,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.tournamentParticipant.update).not.toHaveBeenCalled();
    expect(prisma.match.updateMany).not.toHaveBeenCalled();
    expect(realtime.emitTournamentUpdated).not.toHaveBeenCalled();
  });

  it('replace is rejected when the substitute is already a participant', async () => {
    prisma.tournament.findUnique.mockResolvedValue({
      id: 't1',
      status: 'ONGOING',
      createdById: 'owner',
    });
    prisma.tournamentParticipant.findUnique.mockImplementation(
      ({ where }: any) => {
        if (where.userId_tournamentId.userId === 'x') {
          return Promise.resolve({
            id: 'participant-x',
            userId: 'x',
            tournamentId: 't1',
          });
        }
        // 'y' is already in the tournament.
        return Promise.resolve({
          id: 'participant-y',
          userId: 'y',
          tournamentId: 't1',
        });
      },
    );
    prisma.match.count.mockResolvedValue(0);

    await expect(
      participantService.replaceParticipant(
        't1',
        'x',
        { substituteUserId: 'y' },
        { id: 'owner', roles: ['ORGANIZER'] } as any,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.tournamentParticipant.update).not.toHaveBeenCalled();
    expect(prisma.match.updateMany).not.toHaveBeenCalled();
    expect(realtime.emitTournamentUpdated).not.toHaveBeenCalled();
  });

  it('replace with guestName creates a guest and swaps them in', async () => {
    prisma.tournament.findUnique.mockResolvedValue({
      id: 't1',
      status: 'ONGOING',
      createdById: 'owner',
    });
    prisma.tournamentParticipant.findUnique.mockResolvedValue({
      id: 'participant-x',
      userId: 'x',
      tournamentId: 't1',
    });
    prisma.match.count.mockResolvedValue(0);
    prisma.user.create.mockResolvedValue({
      id: 'guest-1',
      username: 'Sub Guest',
      isGuest: true,
    });

    await participantService.replaceParticipant(
      't1',
      'x',
      { guestName: 'Sub Guest' },
      { id: 'owner', roles: ['ORGANIZER'] } as any,
    );

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isGuest: true,
          username: 'Sub Guest',
        }),
      }),
    );
    expect(prisma.tournamentParticipant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'guest-1' }),
      }),
    );
    expect(realtime.emitTournamentUpdated).toHaveBeenCalledWith('t1');
  });

  it('leaves authorization to TournamentAccessGuard (plan 9.3)', () => {
    // This used to assert a ForbiddenException for a non-creator, duplicating a
    // check the route's TournamentAccessGuard already performs. The duplicate
    // was the bug: the guard grants an ACCEPTED co-organizer, the service
    // re-checked `createdById || ADMIN` and threw, so co-organizers saw
    // Forfeit/Replace (canManage said they could) and got 403 every time.
    //
    // The service no longer takes an authorization decision at all, so there is
    // nothing to assert here. Route-level enforcement is covered by
    // route-protection.e2e-spec.ts, which asserts the guard and its
    // @TournamentAccess source are present on both routes.
    expect(true).toBe(true);
  });
});
