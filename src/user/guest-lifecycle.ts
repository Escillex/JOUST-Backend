import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export const GUEST_RETENTION_DAYS = 30;
const retentionMs = GUEST_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export const guestHistoryInclude = {
  participatedTournaments: {
    select: {
      placement: true,
      tournament: {
        select: {
          id: true, name: true, status: true, completedAt: true,
          guestCleanupAt: true, winnerId: true,
          guestHistoryExclusions: { select: { id: true, reason: true, createdAt: true } },
        },
      },
    },
  },
} satisfies Prisma.UserInclude;

export type GuestRecord = Prisma.UserGetPayload<{ include: typeof guestHistoryInclude }>;

/** Completion starts the claim window. Unfinished events never lose entrants. */
export function guestDeadline(guest: GuestRecord): Date | null {
  const entries = guest.participatedTournaments;
  if (entries.some((p) => p.tournament.status !== 'COMPLETED')) return null;
  const deadlines = entries.map(({ tournament: t }) =>
    t.completedAt ? t.completedAt.getTime() + retentionMs
      : (t.guestCleanupAt ?? guest.expiresAt)?.getTime()
        ?? guest.createdAt.getTime() + retentionMs,
  );
  return new Date(deadlines.length ? Math.min(...deadlines)
    : (guest.expiresAt?.getTime() ?? guest.createdAt.getTime() + retentionMs));
}

export function guestClaimProblem(guest: GuestRecord, now = new Date()): string | null {
  if (!guest.isGuest) return 'This player already has an account.';
  if (!guest.username) return 'This guest name has expired or been reassigned. Its history can no longer be claimed.';
  const deadline = guestDeadline(guest);
  if (deadline && deadline <= now) return 'The guest registration window has expired. Create a new account instead.';
  return null;
}

/** Keep event-only records on an unclaimable identity; release its unique handle.
 * A new user must never inherit this UUID, its results, or its awards.
 * Call within a serializable transaction shared with conversion/reassignment.
 */
export async function retireGuest(tx: Prisma.TransactionClient, guest: GuestRecord) {
  if (!guest.isGuest || !guest.username) return;
  if (guest.participatedTournaments.some((p) => p.tournament.status !== 'COMPLETED')) {
    throw new ConflictException('That guest name is in use in an unfinished tournament. Register the verified player first, or use a different guest name.');
  }
  await tx.user.update({
    where: { id: guest.id },
    data: {
      username: null, slug: null, displayName: guest.displayName || guest.username,
      isExpired: true, expiresAt: new Date(), email: null, hashedPassword: null,
      bio: null, avatarUrl: null, roles: ['PLAYER'],
    },
  });
}
