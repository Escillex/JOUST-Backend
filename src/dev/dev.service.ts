import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TwoFactorService } from '../auth/two-factor.service';
import { isProduction } from '../config/security.config';
import { ParticipantService } from '../tournament/participant/participant.service';
import { TournamentService } from '../tournament/tournament.service';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import {
  effectiveRawConfig,
  resolveConfig,
} from '../Formats/format-config.helper';
import { TournamentStatus } from '@prisma/client';

@Injectable()
export class DevService {
  private readonly logger = new Logger(DevService.name);
  constructor(
    private prisma: PrismaService,
    private participantService: ParticipantService,
    private leaderboardService: LeaderboardService,
  ) {}

  /**
   * Rebuilds all UserGameStats rows from historical data. Match-level
   * aggregates come from TournamentParticipantStats of every tournament
   * whose format has a game designation; tournament counts and placement
   * points only from COMPLETED ones (mirroring completeTournament).
   */
  async backfillGameStats() {
    await this.prisma.userGameStats.deleteMany({});

    const tournaments = await this.prisma.tournament.findMany({
      // A tournament contributes per-game stats if it has a game (the new source
      // of truth) or a legacy format.gameName not yet backfilled (todo.md §5).
      where: {
        OR: [
          { gameId: { not: null } },
          { format: { gameName: { not: null } } },
        ],
      },
      include: {
        format: true,
        game: { select: { name: true } },
        participants: { include: { user: true, stats: true } },
      },
    });

    type Agg = {
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
    const byKey = new Map<string, Agg>();
    const aggFor = (userId: string, gameName: string): Agg => {
      const key = `${userId}::${gameName}`;
      let agg = byKey.get(key);
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
        byKey.set(key, agg);
      }
      return agg;
    };

    for (const t of tournaments) {
      const gameName = t.game?.name ?? t.format?.gameName;
      if (!gameName) continue;

      const registered = t.participants.filter(
        (p) => p.user && !p.user.isGuest,
      );

      for (const p of registered) {
        if (!p.stats) continue;
        const agg = aggFor(p.userId, gameName);
        agg.gamesPlayed += p.stats.gamesPlayed;
        agg.wins += p.stats.wins;
        agg.losses += p.stats.losses;
        agg.draws += p.stats.draws;
      }

      if (t.status !== TournamentStatus.COMPLETED) continue;

      for (const p of registered) {
        aggFor(p.userId, gameName).tournamentsPlayed += 1;
      }
      if (t.winnerId && registered.some((p) => p.userId === t.winnerId)) {
        aggFor(t.winnerId, gameName).tournamentsWon += 1;
      }

      const config = resolveConfig(effectiveRawConfig(t));
      const isHybrid = t.format?.system === 'HYBRID';
      const leaderboard = await this.leaderboardService.getLeaderboard(t.id);
      for (const entry of leaderboard) {
        if (!registered.some((p) => p.userId === entry.userId)) continue;
        let pts: number;
        if (entry.rank === 1) pts = config.placementPointsChampion;
        else if (entry.rank === 2) pts = config.placementPoints2nd;
        else if (entry.rank === 3) pts = config.placementPoints3rd;
        else if (isHybrid) pts = config.placementPointsTopCut;
        else pts = config.placementPointsParticipation;
        aggFor(entry.userId, gameName).globalPoints += pts;
      }
    }

    const rows = [...byKey.values()].map((a) => ({
      ...a,
      winRate: a.gamesPlayed > 0 ? a.wins / a.gamesPlayed : 0,
    }));
    if (rows.length > 0) {
      await this.prisma.userGameStats.createMany({ data: rows });
    }
    return {
      message: `Rebuilt per-game stats: ${rows.length} rows from ${tournaments.length} game-designated tournaments.`,
    };
  }

  async batchAddGuests(tournamentId: string, count: number) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');

    const results: any[] = [];
    for (let i = 1; i <= count; i++) {
      const name = `Guest_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
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
    // references it. The old code deleted matches round-by-round (in no particular
    // order), which threw a FK error whenever a referenced later-round match went
    // first. Mirror discardGeneratedBracket: null the links, then delete matches,
    // rounds, participants, and finally the tournament — all in one transaction so
    // a partial delete can't strand the row half-gone. (GameRequest.tournamentId is
    // SetNull and MatchGameLog/TournamentOrganizer cascade, so those need no help.)
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

    return {
      message: `Tournament "${tournament.name}" and all related data deleted.`,
    };
  }
}
