import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TwoFactorService } from '../auth/two-factor.service';
import { SettingsService } from '../settings/settings.service';
import { isProduction } from '../config/security.config';
import { ParticipantService } from '../tournament/participant/participant.service';
import { TournamentService } from '../tournament/tournament.service';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import {
  effectiveRawConfig,
  resolveConfig,
  systemOf,
} from '../Formats/format-config.helper';
import { TournamentStatus } from '@prisma/client';

@Injectable()
export class DevService {
  private readonly logger = new Logger(DevService.name);
  constructor(
    private prisma: PrismaService,
    private participantService: ParticipantService,
    private leaderboardService: LeaderboardService,
    private settings: SettingsService,
  ) {}

  /**
   * Rebuilds all UserGlobalStats and UserGameStats rows from historical data.
   * Match-level aggregates come from TournamentParticipantStats; tournament
   * counts and placement points only from COMPLETED tournaments (mirroring
   * completeTournament). This ensures full reconciliation if a tournament was
   * deleted or modified.
   */
  async backfillGameStats() {
    await this.prisma.userGameStats.deleteMany({});
    await this.prisma.userGlobalStats.deleteMany({});

    const tournaments = await this.prisma.tournament.findMany({
      include: {
        format: true,
        game: { select: { name: true } },
        participants: { include: { user: true, stats: true } },
      },
    });

    type GameAgg = {
      userId: string;
      gameName: string;
      tournamentsPlayed: number;
      tournamentsWon: number;
      gamesPlayed: number;
      wins: number;
      losses: number;
      draws: number;
      globalPoints: number;
    };

    type GlobalAgg = {
      userId: string;
      tournamentsPlayed: number;
      tournamentsWon: number;
      gamesPlayed: number;
      wins: number;
      losses: number;
      draws: number;
      globalPoints: number;
    };

    const byGameKey = new Map<string, GameAgg>();
    const byGlobalKey = new Map<string, GlobalAgg>();

    const gameAggFor = (userId: string, gameName: string): GameAgg => {
      const key = `${userId}::${gameName}`;
      let agg = byGameKey.get(key);
      if (!agg) {
        agg = {
          userId,
          gameName,
          tournamentsPlayed: 0,
          tournamentsWon: 0,
          gamesPlayed: 0,
          wins: 0,
          losses: 0,
          draws: 0,
          globalPoints: 0,
        };
        byGameKey.set(key, agg);
      }
      return agg;
    };

    const globalAggFor = (userId: string): GlobalAgg => {
      let agg = byGlobalKey.get(userId);
      if (!agg) {
        agg = {
          userId,
          tournamentsPlayed: 0,
          tournamentsWon: 0,
          gamesPlayed: 0,
          wins: 0,
          losses: 0,
          draws: 0,
          globalPoints: 0,
        };
        byGlobalKey.set(userId, agg);
      }
      return agg;
    };

    for (const t of tournaments) {
      const gameName = t.game?.name ?? t.format?.gameName ?? null;

      const registered = t.participants.filter(
        (p) => p.user && !p.user.isGuest,
      );

      for (const p of registered) {
        if (!p.stats) continue;

        const glob = globalAggFor(p.userId);
        glob.gamesPlayed += p.stats.gamesPlayed;
        glob.wins += p.stats.wins;
        glob.losses += p.stats.losses;
        glob.draws += p.stats.draws;

        if (gameName) {
          const gm = gameAggFor(p.userId, gameName);
          gm.gamesPlayed += p.stats.gamesPlayed;
          gm.wins += p.stats.wins;
          gm.losses += p.stats.losses;
          gm.draws += p.stats.draws;
        }
      }

      if (t.status !== TournamentStatus.COMPLETED) continue;

      for (const p of registered) {
        globalAggFor(p.userId).tournamentsPlayed += 1;
        if (gameName) {
          gameAggFor(p.userId, gameName).tournamentsPlayed += 1;
        }
      }
      if (t.winnerId && registered.some((p) => p.userId === t.winnerId)) {
        globalAggFor(t.winnerId).tournamentsWon += 1;
        if (gameName) {
          gameAggFor(t.winnerId, gameName).tournamentsWon += 1;
        }
      }

      const config = resolveConfig(effectiveRawConfig(t));
      const isHybrid = systemOf(t) === 'HYBRID';
      const leaderboard = await this.leaderboardService.getLeaderboard(t.id);
      for (const entry of leaderboard) {
        if (!registered.some((p) => p.userId === entry.userId)) continue;
        let pts: number;
        if (entry.rank === 1) pts = config.placementPointsChampion;
        else if (entry.rank === 2) pts = config.placementPoints2nd;
        else if (entry.rank === 3) pts = config.placementPoints3rd;
        else if (isHybrid) pts = config.placementPointsTopCut;
        else pts = config.placementPointsParticipation;

        globalAggFor(entry.userId).globalPoints += pts;
        if (gameName) {
          gameAggFor(entry.userId, gameName).globalPoints += pts;
        }
      }
    }

    const gameRows = [...byGameKey.values()].map((a) => ({
      ...a,
      winRate: a.gamesPlayed > 0 ? a.wins / a.gamesPlayed : 0,
    }));
    if (gameRows.length > 0) {
      await this.prisma.userGameStats.createMany({ data: gameRows });
    }

    const globalRows = [...byGlobalKey.values()].map((a) => ({
      ...a,
      winRate: a.gamesPlayed > 0 ? a.wins / a.gamesPlayed : 0,
    }));
    if (globalRows.length > 0) {
      await this.prisma.userGlobalStats.createMany({ data: globalRows });
    }

    return {
      message: `Rebuilt stats: ${globalRows.length} global row(s) and ${gameRows.length} per-game row(s) from ${tournaments.length} tournament(s).`,
    };
  }

  /** Refuses unless participant addition has been explicitly allowed in settings.
   *  Enforced here rather than only in the UI — a hidden button is not a
   *  restriction, and this endpoint mints real user rows in a loop. */
  private async assertBulkGuestsAllowed() {
    if (!(await this.settings.getBoolean('DEV_BULK_GUESTS'))) {
      throw new ForbiddenException(
        'Bulk guest creation is disabled. Enable "Allow Bulk Guest Creation" in Admin → Settings before using it.',
      );
    }
  }

  async batchAddGuests(tournamentId: string, count: number, names?: string[]) {
    await this.assertBulkGuestsAllowed();
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');

    const results: any[] = [];
    for (let i = 1; i <= count; i++) {
      // "Swift Falcon" reads as a competitor on a bracket; "Guest_4X9K2" reads
      // as a placeholder. The caller supplies the names from the shared pool;
      // this fallback only runs when the endpoint is called directly.
      const name =
        names?.[i - 1]?.trim() ||
        `Guest ${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
      const res = await this.participantService.joinTournamentAsGuest(
        tournamentId,
        name,
      );
      results.push(res);
    }
    return { message: `Added ${count} guests to tournament`, results };
  }

  /**
   * Turn the second factor down while debugging something unrelated.
   *
   * Deliberately in-memory, exactly like `setGuestExpiry` below: a disabled
   * second factor that cannot survive a process restart is far safer than one
   * persisted in a table, where it would quietly outlive whoever flipped it.
   * Restart returns to the configured mode.
   *
   * Refused in production unless ALLOW_2FA_BYPASS is explicitly set — a debug
   * switch that silently works in prod is a backdoor, not a debug switch.
   */
  setTwoFactorEnforcement(mode: 'all' | 'staff' | 'off', actorId?: string) {
    if (isProduction() && process.env.ALLOW_2FA_BYPASS !== 'true') {
      throw new ForbiddenException(
        'Changing 2FA enforcement is disabled in production. Set ALLOW_2FA_BYPASS=true to override.',
      );
    }
    TwoFactorService.enforcementOverride = mode;
    // Loud on purpose: the window where the second factor was off must be
    // reconstructable from the logs.
    this.logger.warn(
      `2FA enforcement overridden to "${mode}"${actorId ? ` by ${actorId}` : ''} (resets on restart)`,
    );
    return {
      mode,
      message: `Two-factor enforcement set to "${mode}" until restart.`,
    };
  }

  getTwoFactorEnforcement() {
    return {
      override: TwoFactorService.enforcementOverride,
      effective: TwoFactorService.enforcementOverride ?? 'configured',
    };
  }

  async setGuestExpiry(days: number) {
    TournamentService.GUEST_EXPIRY_DAYS = days;
    return {
      message: `Guest expiration period updated to ${days} days.`,
      current: TournamentService.GUEST_EXPIRY_DAYS,
    };
  }

  async deleteTournament(tournamentId: string) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');

    // F13. Matches point at each other through nextMatchId / loserNextMatchId,
    // which are Restrict, so a match cannot be deleted while another still
    // references it. Mirror discardGeneratedBracket: null the links, then delete matches,
    // rounds, participants, and finally the tournament — all in one transaction so
    // a partial delete can't strand the row half-gone.
    await this.prisma.$transaction(async (tx) => {
      await tx.match.updateMany({
        where: { round: { tournamentId } },
        data: { nextMatchId: null, loserNextMatchId: null },
      });
      await tx.match.deleteMany({ where: { round: { tournamentId } } });
      await tx.round.deleteMany({ where: { tournamentId } });
      await tx.tournamentParticipant.deleteMany({ where: { tournamentId } });
      await tx.tournament.delete({ where: { id: tournamentId } });
    });

    // Rebuild global and per-game stats from remaining tournaments so player records
    // are automatically reconciled and never contain phantom wins/losses/points.
    await this.backfillGameStats();

    return {
      message: `Tournament "${tournament.name}" and all related data deleted.`,
    };
  }
}
