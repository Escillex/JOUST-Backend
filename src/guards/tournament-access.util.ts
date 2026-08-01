import { OrganizerInviteStatus, Role } from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';
import type { JwtPayload } from './jwt-auth.guard';

export type TournamentAccessResult = 'ALLOWED' | 'DENIED' | 'NOT_FOUND';

/** The single definition of "may this user manage this tournament".
 *  Every enforcement point - the guard, and the two endpoints whose rule depends
 *  on the target user rather than the route - goes through here, so there is one
 *  place to read and one place to change. */
export async function checkTournamentAccess(
  prisma: PrismaService,
  tournamentId: string,
  user: JwtPayload | null | undefined,
): Promise<TournamentAccessResult> {
  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { createdById: true },
  });

  // Existence is checked before authorization so a missing tournament reports 404
  // rather than a misleading 403, for admins and non-admins alike.
  if (!tournament) return 'NOT_FOUND';
  if (!user) return 'DENIED';
  if (user.roles?.includes(Role.ADMIN)) return 'ALLOWED';
  // A null creator means the account was deleted and nobody owns this tournament,
  // so only the ADMIN branch above can reach it.
  if (tournament.createdById && tournament.createdById === user.id) {
    return 'ALLOWED';
  }

  // Third and final clause: staff the creator invited and who accepted. Checked
  // last, and only once the cheap clauses have failed, so the common paths still
  // cost a single query. PENDING and DECLINED grant nothing - access begins on
  // acceptance, not on invitation.
  const staff = await prisma.tournamentOrganizer.findUnique({
    where: { tournamentId_userId: { tournamentId, userId: user.id } },
    select: { status: true },
  });
  return staff?.status === OrganizerInviteStatus.ACCEPTED
    ? 'ALLOWED'
    : 'DENIED';
}
