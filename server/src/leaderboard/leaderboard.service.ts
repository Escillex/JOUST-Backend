import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MatchStatus } from '@prisma/client';

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  points: number;
  wins: number;
  losses: number;
  draws: number;
  matchWinPct: number;
  omw: number;
  oomw: number;
}

@Injectable()
export class LeaderboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getLeaderboard(tournamentId: string): Promise<LeaderboardEntry[]> {
    const matches = await this.prisma.match.findMany({
      where: {
        round: { tournamentId },
        status: MatchStatus.COMPLETED,
      },
      select: {
        player1Id: true,
        player2Id: true,
        winnerId: true,
        isBye: true,
      },
    });

    const participants = await this.prisma.tournamentParticipant.findMany({
      where: { tournamentId },
      include: { user: { select: { id: true, username: true } } },
    });

    // 👇 fetch formatConfig for custom points
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: { formatConfig: true },
    });

    // 👇 use config values if set, fallback to defaults
    const pointsForWin = tournament?.formatConfig?.swissPointsForWin ?? 3;
    const pointsForDraw = tournament?.formatConfig?.swissPointsForDraw ?? 1;
    const pointsForLoss = tournament?.formatConfig?.swissPointsForLoss ?? 0;

    const playerIds = participants.map((p) => p.userId);

    const opponentMap = new Map<string, Set<string>>();
    const winsMap = new Map<string, number>();
    const lossesMap = new Map<string, number>();
    const drawsMap = new Map<string, number>();
    const matchCountMap = new Map<string, number>();

    for (const id of playerIds) {
      opponentMap.set(id, new Set());
      winsMap.set(id, 0);
      lossesMap.set(id, 0);
      drawsMap.set(id, 0);
      matchCountMap.set(id, 0);
    }

    for (const match of matches) {
      const { player1Id: p1, player2Id: p2, winnerId, isBye } = match;
      if (!p1) continue;

      if (isBye) {
        winsMap.set(p1, (winsMap.get(p1) ?? 0) + 1);
        continue;
      }

      if (!p2) continue;

      matchCountMap.set(p1, (matchCountMap.get(p1) ?? 0) + 1);
      matchCountMap.set(p2, (matchCountMap.get(p2) ?? 0) + 1);
      opponentMap.get(p1)?.add(p2);
      opponentMap.get(p2)?.add(p1);

      if (!winnerId) {
        drawsMap.set(p1, (drawsMap.get(p1) ?? 0) + 1);
        drawsMap.set(p2, (drawsMap.get(p2) ?? 0) + 1);
      } else if (winnerId === p1) {
        winsMap.set(p1, (winsMap.get(p1) ?? 0) + 1);
        lossesMap.set(p2, (lossesMap.get(p2) ?? 0) + 1);
      } else {
        winsMap.set(p2, (winsMap.get(p2) ?? 0) + 1);
        lossesMap.set(p1, (lossesMap.get(p1) ?? 0) + 1);
      }
    }

    const mwpMap = new Map<string, number>();
    for (const id of playerIds) {
      const wins = winsMap.get(id) ?? 0;
      const draws = drawsMap.get(id) ?? 0;
      const matchesPlayed = matchCountMap.get(id) ?? 0;

      const byes = matches.filter((m) => m.isBye && m.player1Id === id).length;
      const realWins = wins - byes;

      // 👇 use config points for MWP calculation
      const possiblePoints = matchesPlayed * pointsForWin;
      const earnedPoints = realWins * pointsForWin + draws * pointsForDraw;

      const raw = possiblePoints === 0 ? 0.33 : earnedPoints / possiblePoints;
      mwpMap.set(id, Math.max(raw, 0.33));
    }

    const omwMap = new Map<string, number>();
    for (const id of playerIds) {
      const opponents = [...(opponentMap.get(id) ?? [])];
      if (opponents.length === 0) {
        omwMap.set(id, 0.33);
        continue;
      }
      const avg =
        opponents.reduce((sum, oppId) => sum + (mwpMap.get(oppId) ?? 0.33), 0) /
        opponents.length;
      omwMap.set(id, Math.max(avg, 0.33));
    }

    const oomwMap = new Map<string, number>();
    for (const id of playerIds) {
      const opponents = [...(opponentMap.get(id) ?? [])];
      if (opponents.length === 0) {
        oomwMap.set(id, 0.33);
        continue;
      }
      const avg =
        opponents.reduce((sum, oppId) => sum + (omwMap.get(oppId) ?? 0.33), 0) /
        opponents.length;
      oomwMap.set(id, avg);
    }

    // 👇 use config points for final score calculation
    const entries: Omit<LeaderboardEntry, 'rank'>[] = participants.map((p) => {
      const id = p.userId;
      const wins = winsMap.get(id) ?? 0;
      const losses = lossesMap.get(id) ?? 0;
      const draws = drawsMap.get(id) ?? 0;

      const byes = matches.filter((m) => m.isBye && m.player1Id === id).length;
      const realWins = wins - byes;

      return {
        userId: id,
        username: p.user.username ?? 'Guest',
        points:
          realWins * pointsForWin +
          draws * pointsForDraw +
          losses * pointsForLoss +
          byes * pointsForWin,
        wins,
        losses,
        draws,
        matchWinPct: mwpMap.get(id) ?? 0.33,
        omw: omwMap.get(id) ?? 0.33,
        oomw: oomwMap.get(id) ?? 0.33,
      };
    });

    entries.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (Math.abs(b.omw - a.omw) > 0.0001) return b.omw - a.omw;
      if (Math.abs(b.oomw - a.oomw) > 0.0001) return b.oomw - a.oomw;
      return b.matchWinPct - a.matchWinPct;
    });

    const ranked: LeaderboardEntry[] = [];
    let currentRank = 1;
    for (let i = 0; i < entries.length; i++) {
      if (
        i > 0 &&
        (entries[i].points !== entries[i - 1].points ||
          Math.abs(entries[i].omw - entries[i - 1].omw) > 0.0001 ||
          Math.abs(entries[i].oomw - entries[i - 1].oomw) > 0.0001 ||
          Math.abs(entries[i].matchWinPct - entries[i - 1].matchWinPct) >
            0.0001)
      ) {
        currentRank = i + 1;
      }
      ranked.push({ rank: currentRank, ...entries[i] });
    }

    return ranked;
  }
}
