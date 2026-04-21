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
    // 1. Fetch all completed matches for this tournament
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

    // 2. Fetch all participants
    const participants = await this.prisma.tournamentParticipant.findMany({
      where: { tournamentId },
      include: { user: { select: { id: true, username: true } } },
    });

    const playerIds = participants.map((p) => p.userId);

    // 3. Build data maps
    const opponentMap = new Map<string, Set<string>>();
    const winsMap = new Map<string, number>();
    const lossesMap = new Map<string, number>();
    const drawsMap = new Map<string, number>();
    const matchCountMap = new Map<string, number>(); // Actual matches played (excluding byes)

    for (const id of playerIds) {
      opponentMap.set(id, new Set());
      winsMap.set(id, 0);
      lossesMap.set(id, 0);
      drawsMap.set(id, 0);
      matchCountMap.set(id, 0);
    }

    // 4. Calculate stats from matches
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
        // DRAW
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

    // 5. Calculate Match Win % (MWP)
    // MWP = (Wins*3 + Draws*1) / (MatchesPlayed*3)
    const mwpMap = new Map<string, number>();
    for (const id of playerIds) {
      const wins = winsMap.get(id) ?? 0;
      const draws = drawsMap.get(id) ?? 0;
      const matchesPlayed = matchCountMap.get(id) ?? 0;
      
      const byes = matches.filter(m => m.isBye && m.player1Id === id).length;
      const realWins = wins - byes;
      
      const possiblePoints = matchesPlayed * 3;
      const earnedPoints = (realWins * 3) + (draws * 1);
      
      const raw = possiblePoints === 0 ? 0.33 : earnedPoints / possiblePoints;
      mwpMap.set(id, Math.max(raw, 0.33));
    }

    // 6. Calculate OMW: average MWP of all opponents
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

    // 7. Calculate OOMW: average OMW of all opponents
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

    // 8. Build and sort leaderboard: Points → OMW → OOMW
    const entries: Omit<LeaderboardEntry, 'rank'>[] = participants.map((p) => {
      const id = p.userId;
      const wins = winsMap.get(id) ?? 0;
      const draws = drawsMap.get(id) ?? 0;
      return {
        userId: id,
        username: p.user.username,
        points: (wins * 3) + (draws * 1),
        wins,
        losses: lossesMap.get(id) ?? 0,
        draws,
        matchWinPct: mwpMap.get(id) ?? 0.33,
        omw: omwMap.get(id) ?? 0.33,
        oomw: oomwMap.get(id) ?? 0.33,
      };
    });

    entries.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (Math.abs(b.omw - a.omw) > 0.0001) return b.omw - a.omw;
      return b.oomw - a.oomw;
    });

    // 9. Assign ranks
    const ranked: LeaderboardEntry[] = [];
    let currentRank = 1;
    for (let i = 0; i < entries.length; i++) {
      if (
        i > 0 &&
        (entries[i].points !== entries[i - 1].points ||
          Math.abs(entries[i].omw - entries[i - 1].omw) > 0.0001 ||
          Math.abs(entries[i].oomw - entries[i - 1].oomw) > 0.0001)
      ) {
        currentRank = i + 1;
      }
      ranked.push({ rank: currentRank, ...entries[i] });
    }

    return ranked;
  }
}