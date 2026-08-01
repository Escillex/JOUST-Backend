import { TournamentController } from '../src/tournament/tournament.controller';
import { ParticipantController } from '../src/tournament/participant/participant.controller';
import { MatchController } from '../src/tournament/match/match.controller';
import { TrackerController } from '../src/tournament/match/tracker/tracker.controller';
import { ImagesController } from '../src/images/images.controller';
import { NotificationController } from '../src/notification/notification.controller';
import { OrganizerController } from '../src/organizer/organizer.controller';
import { InvitationController } from '../src/organizer/invitation.controller';
import { JwtAuthGuard } from '../src/guards/jwt-auth.guard';
import { TournamentAccessGuard } from '../src/guards/tournament-access.guard';
import { TOURNAMENT_ACCESS_KEY } from '../src/guards/decorators/tournament-access.decorator';

// Reading Nest's own metadata is the only way to prove a route is protected without
// booting an HTTP server. A route added later without the guard fails here loudly,
// which is the failure mode this whole phase exists to prevent.
const guardsOf = (handler: unknown): unknown[] =>
  (Reflect.getMetadata('__guards__', handler as object) as unknown[]) ?? [];

const accessSourceOf = (handler: unknown): string | undefined =>
  Reflect.getMetadata(TOURNAMENT_ACCESS_KEY, handler as object) as
    | string
    | undefined;

describe('tournament routes are access-guarded', () => {
  const proto = TournamentController.prototype as unknown as Record<
    string,
    unknown
  >;

  const cases: Array<[string, string]> = [
    ['updateTournament', 'id'],
    ['updateStatus', 'id'],
    ['generateBracket', 'id'],
    ['startTournament', 'id'],
    ['completeTournament', 'id'],
    ['resolveTie', 'id'],
    ['cancelCleanup', 'id'],
  ];

  it.each(cases)(
    '%s uses TournamentAccessGuard with source "%s"',
    (name, source) => {
      expect(guardsOf(proto[name])).toContain(TournamentAccessGuard);
      expect(accessSourceOf(proto[name])).toBe(source);
    },
  );

  it('createTournament is NOT tournament-scoped', () => {
    // Creating a tournament has no tournament to check against; it stays role-gated.
    expect(guardsOf(proto.createTournament)).not.toContain(
      TournamentAccessGuard,
    );
  });
});

describe('participant routes are access-guarded', () => {
  const proto = ParticipantController.prototype as unknown as Record<
    string,
    unknown
  >;

  const cases: Array<[string, string]> = [
    ['updateSeed', 'tournamentId'],
    ['forfeit', 'tournamentId'],
    ['replace', 'tournamentId'],
  ];

  it.each(cases)(
    '%s uses TournamentAccessGuard with source "%s"',
    (name, source) => {
      expect(guardsOf(proto[name])).toContain(TournamentAccessGuard);
      expect(accessSourceOf(proto[name])).toBe(source);
    },
  );

  it('join is NOT guarded, because a player joining themselves must still work', () => {
    expect(guardsOf(proto.join)).not.toContain(TournamentAccessGuard);
  });

  it('joinGuest stays public for on-site registration', () => {
    expect(guardsOf(proto.joinGuest)).toHaveLength(0);
  });

  it('leave is not access-guarded - its rule depends on the target participant', () => {
    expect(guardsOf(proto.leave)).not.toContain(TournamentAccessGuard);
  });
});

describe('match and tracker routes are access-guarded', () => {
  const match = MatchController.prototype as unknown as Record<string, unknown>;
  const tracker = TrackerController.prototype as unknown as Record<
    string,
    unknown
  >;

  it.each([['submitResult'], ['reportGameResult']])(
    'MatchController.%s is guarded by match id',
    (name) => {
      expect(guardsOf(match[name])).toContain(TournamentAccessGuard);
      expect(accessSourceOf(match[name])).toBe('match:id');
    },
  );

  it('exposes no public draw route (plan 7.3)', () => {
    // POST /matches/:id/draw was removed because it validated less than the
    // draw path in submitResult — it skipped the per-system guard, so it was a
    // way to strand an elimination bracket that submit already refused. The
    // internal MatchService.reportDraw remains for the live tracker, with its
    // validation aligned. If a controller method reappears here, that bypass is
    // back.
    expect(match.reportDraw).toBeUndefined();
  });

  it.each([['openTracker'], ['updateTracker'], ['submitGame']])(
    'TrackerController.%s is guarded by match id',
    (name) => {
      expect(guardsOf(tracker[name])).toContain(TournamentAccessGuard);
      expect(accessSourceOf(tracker[name])).toBe('match:id');
    },
  );

  it('tracker reads stay public for spectators', () => {
    expect(guardsOf(tracker.getTrackerLogs)).toHaveLength(0);
  });
});

describe('banner routes are access-guarded', () => {
  const images = ImagesController.prototype as unknown as Record<
    string,
    unknown
  >;

  it.each([['uploadBanner'], ['deleteBanner']])(
    '%s is guarded by tournamentId',
    (name) => {
      expect(guardsOf(images[name])).toContain(TournamentAccessGuard);
      expect(accessSourceOf(images[name])).toBe('tournamentId');
    },
  );
});

describe('notification routes require a login', () => {
  const proto = NotificationController.prototype as unknown as Record<
    string,
    unknown
  >;

  // Every route reads req.user for the scope, so an unauthenticated call would
  // have no inbox to read - these must never be public.
  it.each([['list'], ['markRead'], ['markAllRead']])(
    '%s is behind JwtAuthGuard',
    (name) => {
      expect(guardsOf(proto[name])).toContain(JwtAuthGuard);
    },
  );
});

describe('organizer staff routes', () => {
  const proto = OrganizerController.prototype as unknown as Record<
    string,
    unknown
  >;

  it('list uses TournamentAccessGuard so co-organizers can see the staff list', () => {
    expect(guardsOf(proto.list)).toContain(TournamentAccessGuard);
    expect(accessSourceOf(proto.list)).toBe('tournamentId');
  });

  // invite and revoke are STRICTER than the guard - creator or admin only - so
  // they are role-gated here and creator-checked in the service. Adding the
  // access guard would wrongly admit co-organizers.
  it.each([['invite'], ['revoke']])(
    '%s is authenticated but not access-guarded',
    (name) => {
      expect(guardsOf(proto[name])).toContain(JwtAuthGuard);
      expect(guardsOf(proto[name])).not.toContain(TournamentAccessGuard);
    },
  );
});

describe('organizer invitation routes', () => {
  const proto = InvitationController.prototype as unknown as Record<
    string,
    unknown
  >;

  it.each([['listMine'], ['accept'], ['decline']])(
    '%s is behind JwtAuthGuard',
    (name) => {
      expect(guardsOf(proto[name])).toContain(JwtAuthGuard);
    },
  );
});
