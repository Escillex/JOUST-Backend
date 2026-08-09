import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
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
        OR: [{ gameId: { not: null } }, { format: { gameName: { not: null } } }],
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

    // Delete rounds and matches (Prisma will handle some via Cascade if set, but let's be safe)
    // Actually, in schema.prisma, Match/Round don't have Cascade from Tournament.

    const rounds = await this.prisma.round.findMany({
      where: { tournamentId },
    });
    for (const round of rounds) {
      await this.prisma.match.deleteMany({ where: { roundId: round.id } });
    }
    await this.prisma.round.deleteMany({ where: { tournamentId } });
    await this.prisma.tournamentParticipant.deleteMany({
      where: { tournamentId },
    });

    await this.prisma.tournament.delete({ where: { id: tournamentId } });

    return {
      message: `Tournament "${tournament.name}" and all related data deleted.`,
    };
  }
}
