import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { checkTournamentAccess } from '../../guards/tournament-access.util';
import type { JwtPayload } from '../../guards/jwt-auth.guard';
import type { ScoreSubmissionRule } from '../../Formats/format-config.helper';

/** Who is acting on a match's score.
 *
 *  STAFF: creator / ADMIN / accepted co-organizer of the match's tournament — the
 *  same membership checkTournamentAccess defines for every per-tournament route.
 *  STAFF may open, adjust and confirm anything, and a result they submit is
 *  final on the spot.
 *
 *  PARTICIPANT: a *player of this match* (guests have no credential, so they
 *  never authenticate and can never reach here). When the tournament's
 *  `scoreSubmissionRule` allows player scoring (SELF_REPORT_ALLOWED), a
 *  participant may open games, adjust values and submit results — but a result
 *  that would *finalize* the match is deferred into pending verification for an
 *  organizer to review, instead of completing on the spot.
 *
 *  Decided here, in the service, rather than by a guard: the rule depends on the
 *  tournament's config AND on who the caller is relative to the match, which a
 *  guard cannot read. Same shape as startMatch and tracker/update. */
export type ScoreActor = 'STAFF' | 'PARTICIPANT';

/** The slice of a match this helper needs to decide who the caller is. */
export type ScoreMatchContext = {
  player1Id: string | null | undefined;
  player2Id: string | null | undefined;
  round?: { tournamentId?: string | null } | null;
};

export function isParticipantOfMatch(
  user: JwtPayload | null | undefined,
  match: ScoreMatchContext,
): boolean {
  return (
    !!user?.id &&
    (user.id === match.player1Id || user.id === match.player2Id)
  );
}

/** Resolves and enforces who may act. Throws for a caller who may not act at
 *  all. Where an action is allowed to *participants only under the permissive
 *  rule* (the caller must distinguish "may not" from "may, own slot only"),
 *  use the looser pieces individually instead of this. */
export async function resolveScoreActor(
  prisma: PrismaService,
  match: ScoreMatchContext,
  user: JwtPayload | null | undefined,
  rule: ScoreSubmissionRule,
): Promise<ScoreActor> {
  if (isParticipantOfMatch(user, match)) {
    if (rule === 'STAFF_ONLY') {
      throw new ForbiddenException(
        'An organizer must submit scores in this tournament',
      );
    }
    return 'PARTICIPANT';
  }

  const tournamentId = match.round?.tournamentId;
  const isStaff =
    !!tournamentId &&
    (await checkTournamentAccess(prisma, tournamentId, user)) === 'ALLOWED';
  if (isStaff) return 'STAFF';

  throw new ForbiddenException(
    'Only a player in this match or the tournament organizer can score this match',
  );
}