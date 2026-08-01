import { SetMetadata } from '@nestjs/common';

export const TOURNAMENT_ACCESS_KEY = 'tournamentAccessSource';

/** Where TournamentAccessGuard should look for the tournament this request acts on.
 *  'id' / 'tournamentId' - that route param already is a tournament id.
 *  'match:id'            - the ':id' route param is a match id, so the guard walks
 *                          match -> round -> tournamentId to find the owner. */
export type TournamentAccessSource = 'id' | 'tournamentId' | 'match:id';

export const TournamentAccess = (source: TournamentAccessSource) =>
  SetMetadata(TOURNAMENT_ACCESS_KEY, source);
