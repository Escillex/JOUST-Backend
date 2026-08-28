import { ForbiddenException } from '@nestjs/common';
import { ParticipantService } from '../src/tournament/participant/participant.service';

// Removing a participant has two different rules depending on WHO is being
// removed, which is why it cannot use TournamentAccessGuard: guests stay
// removable without a login (the on-site registration desk has no token to send),
// while a registered account may only be removed by themselves or by staff.

const SELF = {
  id: 'u1',
  email: null,
  username: 'u1',
  roles: ['PLAYER'],
} as any;
const OTHER = {
  id: 'other',
  email: null,
  username: 'o',
  roles: ['ORGANIZER'],
} as any;
const CREATOR = {
  id: 'creator',
  email: null,
  username: 'c',
  roles: ['ORGANIZER'],
} as any;

describe('ParticipantService.leaveTournament permissions', () => {
  let prisma: any;
  let service: ParticipantService;
  // Notifications are best-effort side effects; this suite only asserts the
  // permission rule, so the service is stubbed rather than exercised.
  const notifications = { notify: jest.fn(), notifyMany: jest.fn() } as any;

  beforeEach(() => {
    prisma = {
      tournament: {
        findUnique: jest.fn().mockResolvedValue({
          id: 't1',
          status: 'OPEN',
          createdById: 'creator',
        }),
      },
      tournamentParticipant: {
        findUnique: jest.fn(({ where }: any) =>
          Promise.resolve({
            id: 'p1',
            userId: where.userId_tournamentId.userId,
            tournamentId: 't1',
            user: { isGuest: where.userId_tournamentId.userId === 'guest1' },
          }),
        ),
        delete: jest.fn().mockResolvedValue({}),
      },
      // No co-organizer staff in this suite; it asserts the self/creator rules.
      tournamentOrganizer: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    // Transaction-aware code under test calls prisma.$transaction(cb). The
    // mock runs the callback against itself, so the assertions below are
    // unchanged by the wrapping.
    prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));
    service = new ParticipantService(
      prisma,
      {} as any,
      {} as any,
      notifications,
    );
  });

  // F7: guests are organizer-managed now, so an anonymous caller can no longer
  // remove one — only tournament staff can.
  it('rejects an anonymous caller removing a guest', async () => {
    await expect(service.leaveTournament('t1', 'guest1')).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.tournamentParticipant.delete).not.toHaveBeenCalled();
  });

  it('lets the tournament creator remove a guest', async () => {
    await expect(
      service.leaveTournament('t1', 'guest1', CREATOR),
    ).resolves.toBeDefined();
    expect(prisma.tournamentParticipant.delete).toHaveBeenCalled();
  });

  it('rejects an anonymous caller removing a registered account', async () => {
    await expect(service.leaveTournament('t1', 'u1')).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.tournamentParticipant.delete).not.toHaveBeenCalled();
  });

  it('lets a registered user remove themselves', async () => {
    await expect(
      service.leaveTournament('t1', 'u1', SELF),
    ).resolves.toBeDefined();
  });

  it('lets the tournament creator remove a registered participant', async () => {
    await expect(
      service.leaveTournament('t1', 'u1', CREATOR),
    ).resolves.toBeDefined();
  });

  it('rejects an unrelated organizer removing a registered participant', async () => {
    await expect(service.leaveTournament('t1', 'u1', OTHER)).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.tournamentParticipant.delete).not.toHaveBeenCalled();
  });
});
