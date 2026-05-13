import {
  Injectable,
  BadRequestException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MatchService } from '../tournament/match/match.service';
import { TournamentService } from '../tournament/tournament.service';
import {
  LeaderboardService,
  LeaderboardEntry,
} from '../leaderboard/leaderboard.service';
import {
  TournamentSystem,
  MatchStatus,
  TournamentStatus,
  TournamentFormat,
  Match,
} from '@prisma/client';
import { resolveConfig } from './format-config.helper';

@Injectable()
export class FormatsService {
  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => MatchService))
    private matchService: MatchService,
    @Inject(forwardRef(() => TournamentService))
    private tournamentService: TournamentService,
    private leaderboardService: LeaderboardService,
  ) {}

  async initializeTournamentFormat(
    tournamentId: string,
    format: TournamentFormat,   // full entity from prisma
    playerIds: string[],
    activate: boolean = true,
  ) {
    const system = format.system;
    const config = format.config as Record<string, any>;

    if (system === TournamentSystem.SINGLE_ELIMINATION) {
      await this.initSingleElimination(tournamentId, playerIds, activate);
    } else if (system === TournamentSystem.DOUBLE_ELIMINATION) {
      await this.initDoubleElimination(tournamentId, playerIds, activate);
    } else if (system === TournamentSystem.SWISS) {
      await this.initSwiss(tournamentId, playerIds, activate);
    } else if (system === TournamentSystem.ROUND_ROBIN) {
      await this.initRoundRobin(tournamentId, playerIds, activate);
    } else if (system === TournamentSystem.HYBRID) {
      await this.initHybrid(tournamentId, config, playerIds, activate);
    } else {
      throw new BadRequestException(`System ${system} not supported`);
    }
  }

  async handleMatchCompletion(matchId: string) {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: { round: { include: { tournament: { include: { format: true } } } } },
    });

    if (!match) return;

    const { tournament } = match.round;
    const system = tournament.format?.system;

    if (system === TournamentSystem.SINGLE_ELIMINATION) {
      if (match.nextMatchId && match.winnerId) {
        await this.matchService.advanceWinner(match.winnerId, match.nextMatchId);
      }
      await this.checkSingleEliminationComplete(tournament.id, match.roundId);
    } else if (system === TournamentSystem.DOUBLE_ELIMINATION) {
      if (match.winnerId && match.nextMatchId) {
        await this.matchService.advanceWinner(match.winnerId, match.nextMatchId);
      }
      if (match.loserNextMatchId) {
        const loserId = match.player1Id === match.winnerId ? match.player2Id : match.player1Id;
        if (loserId) await this.matchService.advanceLoser(loserId, match.loserNextMatchId);
      }
      await this.checkTournamentComplete(tournament.id);
    } else if (system === TournamentSystem.SWISS) {
      await this.checkSwissRoundComplete(tournament.id, match.roundId);
    } else if (system === TournamentSystem.ROUND_ROBIN) {
      await this.checkTournamentComplete(tournament.id);
    } else if (system === TournamentSystem.HYBRID) {
      // phase 1 = Swiss; phase 2 = single elim top cut
      if (match.phase === 1) {
        await this.checkHybridPhase1Complete(tournament.id, match.roundId);
      } else {
        // phase 2 uses single-elim logic
        if (match.nextMatchId && match.winnerId) {
          await this.matchService.advanceWinner(match.winnerId, match.nextMatchId);
        }
        await this.checkSingleEliminationComplete(tournament.id, match.roundId);
      }
    }
  }

  // ─── HYBRID (Swiss → Top Cut) ────────────────────────────────

  private async initHybrid(
    tournamentId: string,
    config: Record<string, any>,
    playerIds: string[],
    activate: boolean,
  ) {
    // Phase 1: Swiss — matches tagged with phase=1
    await this.initSwiss(tournamentId, playerIds, activate, 1);
  }

  private async checkHybridPhase1Complete(tournamentId: string, roundId: string) {
    const round = await this.prisma.round.findUnique({
      where: { id: roundId },
      include: { matches: true },
    });
    if (!round || !round.matches.every((m) => m.status === MatchStatus.COMPLETED)) return;

    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: { participants: true, format: true },
    });
    if (!tournament?.format) return;

    const config = tournament.format.config as Record<string, any>;
    const phase1Config = config.phase1 ?? {};
    const maxRounds = phase1Config.swissRounds ??
      Math.max(1, Math.ceil(Math.log2(tournament.participants.length)));

    if (round.roundNumber < maxRounds) {
      // Keep running Swiss
      await this.generateNextSwissRound(tournamentId, round.roundNumber + 1, 1);
      return;
    }

    // Swiss phase complete — begin Top Cut
    const phase2Config = config.phase2 ?? {};
    const topCutSize = phase2Config.topCutSize ?? 8;
    const leaderboard = await this.leaderboardService.getLeaderboard(tournamentId);
    const topN = leaderboard.slice(0, topCutSize).map((e) => e.userId);

    if (topN.length < 2) {
      // Fall through to completion
      await this.tournamentService.completeTournament(tournamentId);
      return;
    }

    // Find the highest existing roundNumber and continue from there
    const rounds = await this.prisma.round.findMany({
      where: { tournamentId },
      orderBy: { roundNumber: 'desc' },
      take: 1,
    });
    const nextRoundOffset = (rounds[0]?.roundNumber ?? 0) + 1;

    await this.initSingleElimination(tournamentId, topN, true, nextRoundOffset, 2);
  }

  private async checkTournamentComplete(tournamentId: string) {
    const allMatches = await this.prisma.match.findMany({
      where: { round: { tournamentId } },
    });
    const allDone =
      allMatches.length > 0 &&
      allMatches.every((m) => m.status === MatchStatus.COMPLETED);
    if (allDone) {
      const leaderboard =
        await this.leaderboardService.getLeaderboard(tournamentId);
      const winnerId = leaderboard.length > 0 ? leaderboard[0].userId : null;

      // Update winnerId first so completeTournament sees it
      await this.prisma.tournament.update({
        where: { id: tournamentId },
        data: { winnerId },
      });

      await this.tournamentService.completeTournament(tournamentId);
    }
  }

  // ─── SINGLE ELIMINATION ───────────────────────────────────────

  private async initSingleElimination(
    tournamentId: string,
    playerIds: string[],
    activate: boolean = true,
    roundOffset: number = 1,
    phase: number = 1,
  ) {
    const bracketSize = this.nextPowerOfTwo(playerIds.length);
    const padded: (string | null)[] = [
      ...playerIds,
      ...Array<string | null>(bracketSize - playerIds.length).fill(null),
    ];
    const rounds = this.generateBracket(padded);

    let prevMatchIds: string[] = [];
    for (let i = 0; i < rounds.length; i++) {
      const round = await this.prisma.round.create({
        data: { tournamentId, roundNumber: roundOffset + i },
      });

      const currentMatchIds: string[] = [];
      for (const m of rounds[i]) {
        const created = await this.matchService.createMatch({
          roundId: round.id,
          player1Id: m.p1 && m.p1 !== 'ALIVE' ? m.p1 : undefined,
          player2Id: m.p2 && m.p2 !== 'ALIVE' ? m.p2 : undefined,
          isBye:
            (m.p1 === null && m.p2 !== null) ||
            (m.p1 !== null && m.p2 === null),
          phase,
        });
        currentMatchIds.push(created.id);

        if (i === 0 && activate) {
          if (created.player1Id && created.player2Id) {
            await this.matchService.activateMatch(created.id);
          } else if (created.isBye && (created.player1Id || created.player2Id)) {
            const winnerId = (created.player1Id || created.player2Id) as string;
            await this.prisma.match.update({
              where: { id: created.id },
              data: { winnerId, status: MatchStatus.COMPLETED },
            });
          }
        }
      }

      if (prevMatchIds.length > 0) {
        await this.matchService.linkMatches(prevMatchIds, currentMatchIds);
      }

      if (i === 0 && activate) {
        const r1Matches = await this.prisma.match.findMany({ where: { roundId: round.id } });
        for (const rm of r1Matches) {
          if (rm.isBye && rm.status === MatchStatus.COMPLETED) {
            await this.handleMatchCompletion(rm.id);
          }
        }
      }

      prevMatchIds = currentMatchIds;
    }
  }

  private async checkSingleEliminationComplete(
    tournamentId: string,
    roundId: string,
  ) {
    const round = await this.prisma.round.findUnique({
      where: { id: roundId },
      include: { matches: true },
    });
    if (!round) return;

    const allDone = round.matches.every(
      (m) => m.status === MatchStatus.COMPLETED,
    );
    if (!allDone) return;

    const hasNextMatchLinks = round.matches.some((m) => m.nextMatchId !== null);
    if (hasNextMatchLinks) return;

    const finalMatch = round.matches.find(
      (m) => m.status === MatchStatus.COMPLETED && m.winnerId,
    );
    if (!finalMatch) return;

    await this.prisma.tournament.update({
      where: { id: tournamentId },
      data: { winnerId: finalMatch.winnerId },
    });

    await this.tournamentService.completeTournament(tournamentId);
  }

  // ─── DOUBLE ELIMINATION ───────────────────────────────────────
  private async initDoubleElimination(
    tournamentId: string,
    playerIds: string[],
    activate: boolean = true,
  ) {
    const bracketSize = this.nextPowerOfTwo(playerIds.length);
    const padded = [
      ...playerIds,
      ...Array(bracketSize - playerIds.length).fill(null),
    ];
    const k = Math.log2(bracketSize);

    // 1. Winners Bracket (Rounds 1 to k)
    const winnersMatchesPerRound = this.generateBracket(padded);
    const winnersMatchIds: string[][] = [];

    for (let i = 0; i < winnersMatchesPerRound.length; i++) {
      const round = await this.prisma.round.create({
        data: { tournamentId, roundNumber: i + 1 },
      });
      const ids: string[] = [];
      for (const m of winnersMatchesPerRound[i]) {
        const created = await this.matchService.createMatch({
          roundId: round.id,
          player1Id: m.p1 && m.p1 !== 'ALIVE' ? m.p1 : undefined,
          player2Id: m.p2 && m.p2 !== 'ALIVE' ? m.p2 : undefined,
          isBye:
            i === 0 &&
            ((m.p1 === null && m.p2 !== null) ||
              (m.p1 !== null && m.p2 === null)),
        });
        ids.push(created.id);
        if (i === 0 && activate) {
          if (created.player1Id && created.player2Id) {
            await this.matchService.activateMatch(created.id);
          } else if (created.isBye && created.player1Id) {
            await this.prisma.match.update({
              where: { id: created.id },
              data: {
                winnerId: created.player1Id,
                status: MatchStatus.COMPLETED,
              },
            });
          }
        }
      }
      winnersMatchIds.push(ids);
    }

    // Link Winners matches (nextMatchId)
    for (let i = 0; i < winnersMatchIds.length - 1; i++) {
      await this.matchService.linkMatches(
        winnersMatchIds[i],
        winnersMatchIds[i + 1],
      );
    }

    // 2. Losers Bracket (Rounds 101 to 100 + 2k-2)
    const losersMatchIds: string[][] = [];
    for (let r = 1; r <= 2 * k - 2; r++) {
      const round = await this.prisma.round.create({
        data: { tournamentId, roundNumber: 100 + r },
      });

      const numMatches = Math.pow(2, k - 1 - Math.ceil(r / 2));
      const ids: string[] = [];
      for (let j = 0; j < numMatches; j++) {
        const m = await this.matchService.createMatch({
          roundId: round.id,
          isBye: false,
        });
        ids.push(m.id);
      }
      losersMatchIds.push(ids);
    }

    // Link Losers matches (nextMatchId)
    for (let r = 0; r < losersMatchIds.length - 1; r++) {
      await this.matchService.linkMatches(
        losersMatchIds[r],
        losersMatchIds[r + 1],
      );
    }

    // Link Winners Losers (loserNextMatchId)
    for (let i = 0; i < winnersMatchIds[0].length; i++) {
      await this.prisma.match.update({
        where: { id: winnersMatchIds[0][i] },
        data: { loserNextMatchId: losersMatchIds[0][Math.floor(i / 2)] },
      });
    }

    for (let i = 1; i < winnersMatchIds.length - 1; i++) {
      const wrMatches = winnersMatchIds[i];
      const lrMatches = losersMatchIds[2 * i - 1]; 
      for (let j = 0; j < wrMatches.length; j++) {
        await this.prisma.match.update({
          where: { id: wrMatches[j] },
          data: { loserNextMatchId: lrMatches[j] },
        });
      }
    }

    // 3. Grand Finals (Round 200)
    const gfRound = await this.prisma.round.create({
      data: { tournamentId, roundNumber: 200 },
    });
    const gfMatch = await this.matchService.createMatch({
      roundId: gfRound.id,
      isBye: false,
    });

    const winnersFinalId = winnersMatchIds[winnersMatchIds.length - 1][0];
    await this.prisma.match.update({
      where: { id: winnersFinalId },
      data: { nextMatchId: gfMatch.id },
    });

    if (losersMatchIds.length > 0) {
      const losersFinalId = losersMatchIds[losersMatchIds.length - 1][0];
      await this.prisma.match.update({
        where: { id: losersFinalId },
        data: { nextMatchId: gfMatch.id },
      });
    } else {
      await this.prisma.match.update({
        where: { id: winnersMatchIds[0][0] },
        data: { loserNextMatchId: gfMatch.id },
      });
    }

    const r1Matches = await this.prisma.match.findMany({
      where: { round: { tournamentId, roundNumber: 1 } },
    });
    if (activate) {
      for (const rm of r1Matches) {
        if (rm.isBye && rm.status === MatchStatus.COMPLETED) {
          await this.handleMatchCompletion(rm.id);
        }
      }
    }
  }

  // ─── SWISS ───────────────────────────────────────────────────

  private async initSwiss(tournamentId: string, playerIds: string[], activate: boolean = true, phase: number = 1) {
    const shuffledPlayers = this.shuffle(playerIds);
    const round = await this.prisma.round.create({
      data: { tournamentId, roundNumber: 1 },
    });

    const matchesCreated: Match[] = [];
    for (let i = 0; i < shuffledPlayers.length; i += 2) {
      const p1 = shuffledPlayers[i];
      const p2 = shuffledPlayers[i + 1] || null;
      const match = await this.matchService.createMatch({
        roundId: round.id,
        player1Id: p1,
        player2Id: p2 || undefined,
        isBye: p2 === null,
        phase,
      });
      matchesCreated.push(match);

      if (p1 && p2 && activate) await this.matchService.activateMatch(match.id);
      else if (p1 && !p2) {
        await this.prisma.match.update({
          where: { id: match.id },
          data: { winnerId: p1, status: MatchStatus.COMPLETED },
        });
      }
    }

    if (activate) {
      for (const m of matchesCreated) {
        const updated = await this.prisma.match.findUnique({
          where: { id: m.id },
        });
        if (updated?.status === MatchStatus.COMPLETED) {
          await this.handleMatchCompletion(updated.id);
        }
      }
    }
  }

  private async checkSwissRoundComplete(tournamentId: string, roundId: string) {
    const round = await this.prisma.round.findUnique({
      where: { id: roundId },
      include: { matches: true },
    });
    if (
      !round ||
      !round.matches.every((m) => m.status === MatchStatus.COMPLETED)
    )
      return;

    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: { participants: true, format: true },
    });

    const rawConfig = (tournament?.format?.config as Record<string, any>) ?? {};
    const config = resolveConfig(rawConfig);
    const maxRounds = config.swissRounds ?? Math.max(
      1,
      Math.ceil(Math.log2(tournament!.participants.length)),
    );

    if (round.roundNumber >= maxRounds) {
      const leaderboard = await this.leaderboardService.getLeaderboard(tournamentId);
      const winnerId = leaderboard.length > 0 ? leaderboard[0].userId : null;
      await this.prisma.tournament.update({ where: { id: tournamentId }, data: { winnerId } });
      await this.tournamentService.completeTournament(tournamentId);
      return;
    }

    await this.generateNextSwissRound(tournamentId, round.roundNumber + 1);
  }

  private async generateNextSwissRound(
    tournamentId: string,
    roundNumber: number,
    phase: number = 1,
  ) {
    const leaderboard =
      await this.leaderboardService.getLeaderboard(tournamentId);
    const { opponentHistory, byeCount } =
      await this.buildSwissMatchHistory(tournamentId);

    const sortedIds = leaderboard.map((s) => s.userId);
    const pairableIds = [...sortedIds];
    let byePlayer: string | null = null;

    if (pairableIds.length % 2 !== 0) {
      const eligibleByePlayers = sortedIds.filter(
        (playerId) => (byeCount.get(playerId) ?? 0) === 0,
      );
      byePlayer =
        eligibleByePlayers.length > 0
          ? eligibleByePlayers[eligibleByePlayers.length - 1]
          : sortedIds[sortedIds.length - 1];
      const byeIndex = pairableIds.indexOf(byePlayer);
      if (byeIndex >= 0) pairableIds.splice(byeIndex, 1);
    }

    const round = await this.prisma.round.create({
      data: { tournamentId, roundNumber },
    });

    const pairings = this.buildSwissPairings(
      pairableIds,
      leaderboard,
      opponentHistory,
    );

    const matchesCreated: Match[] = [];

    for (const [p1, p2] of pairings) {
      const match = await this.matchService.createMatch({
        roundId: round.id,
        player1Id: p1,
        player2Id: p2,
        isBye: false,
      });
      matchesCreated.push(match);
      await this.matchService.activateMatch(match.id);
    }

    if (byePlayer) {
      const byeMatch = await this.matchService.createMatch({
        roundId: round.id,
        player1Id: byePlayer,
        player2Id: undefined,
        isBye: true,
      });
      matchesCreated.push(byeMatch);
      await this.prisma.match.update({
        where: { id: byeMatch.id },
        data: { winnerId: byePlayer, status: MatchStatus.COMPLETED },
      });
    }

    for (const m of matchesCreated) {
      const updated = await this.prisma.match.findUnique({
        where: { id: m.id },
      });
      if (updated?.status === MatchStatus.COMPLETED) {
        await this.handleMatchCompletion(updated.id);
      }
    }
  }

  private async buildSwissMatchHistory(tournamentId: string) {
    const matches = await this.prisma.match.findMany({
      where: { round: { tournamentId } },
      select: {
        player1Id: true,
        player2Id: true,
        isBye: true,
      },
    });

    const opponentHistory = new Map<string, Set<string>>();
    const byeCount = new Map<string, number>();

    for (const match of matches) {
      const { player1Id: p1, player2Id: p2, isBye } = match;
      if (!p1) continue;

      if (!opponentHistory.has(p1)) opponentHistory.set(p1, new Set());
      byeCount.set(p1, (byeCount.get(p1) ?? 0) + (isBye ? 1 : 0));

      if (isBye || !p2) continue;

      if (!opponentHistory.has(p2)) opponentHistory.set(p2, new Set());
      opponentHistory.get(p1)?.add(p2);
      opponentHistory.get(p2)?.add(p1);
    }

    return { opponentHistory, byeCount };
  }

  private buildSwissPairings(
    playerIds: string[],
    leaderboard: LeaderboardEntry[],
    opponentHistory: Map<string, Set<string>>,
  ) {
    const scoreMap = new Map<string, number>(
      leaderboard.map((e) => [e.userId, e.points]),
    );

    const sortedIds = [...playerIds];
    const pairings: Array<[string, string]> = [];
    const used = new Set<string>();

    for (let i = 0; i < sortedIds.length; i++) {
      const p1 = sortedIds[i];
      if (used.has(p1)) continue;

      const p1Score = scoreMap.get(p1) ?? 0;

      let bestP2: string | null = null;
      let bestScoreDiff = Infinity;
      let fallbackP2: string | null = null;
      let fallbackScoreDiff = Infinity;

      for (let j = i + 1; j < sortedIds.length; j++) {
        const candidate = sortedIds[j];
        if (used.has(candidate)) continue;

        const diff = Math.abs((scoreMap.get(candidate) ?? 0) - p1Score);
        const isRepeat = opponentHistory.get(p1)?.has(candidate) ?? false;

        if (!isRepeat) {
          if (diff < bestScoreDiff) {
            bestP2 = candidate;
            bestScoreDiff = diff;
          }
        } else {
          if (diff < fallbackScoreDiff) {
            fallbackP2 = candidate;
            fallbackScoreDiff = diff;
          }
        }
      }

      const p2 = bestP2 ?? fallbackP2;
      if (p2) {
        pairings.push([p1, p2]);
        used.add(p1);
        used.add(p2);
      }
    }

    return pairings;
  }

  // ─── ROUND ROBIN ─────────────────────────────────────────────

  private async initRoundRobin(tournamentId: string, playerIds: string[], activate: boolean = true) {
    const n = playerIds.length;
    const players = [...playerIds];
    if (n % 2 !== 0) players.push(null as any);
    const numRounds = players.length - 1;
    const half = players.length / 2;

    for (let r = 0; r < numRounds; r++) {
      const round = await this.prisma.round.create({
        data: { tournamentId, roundNumber: r + 1 },
      });

      for (let i = 0; i < half; i++) {
        const p1 = players[i];
        const p2 = players[players.length - 1 - i];

        if (p1 && p2) {
          const match = await this.matchService.createMatch({
            roundId: round.id,
            player1Id: p1,
            player2Id: p2,
            isBye: false,
          });
          if (activate) await this.matchService.activateMatch(match.id);
        } else if (p1 || p2) {
          const p = p1 || p2;
          const match = await this.matchService.createMatch({
            roundId: round.id,
            player1Id: p,
            isBye: true,
          });
          await this.prisma.match.update({
            where: { id: match.id },
            data: { winnerId: p, status: MatchStatus.COMPLETED },
          });
          if (activate) await this.handleMatchCompletion(match.id);
        }
      }
      players.splice(1, 0, players.pop()!);
    }
  }

  private shuffle(array: string[]): string[] {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  private nextPowerOfTwo(n: number): number {
    let power = 1;
    while (power < n) power *= 2;
    return power;
  }

  private generateBracket(
    players: (string | null)[],
  ): { p1: string | null; p2: string | null }[][] {
    const rounds: { p1: string | null; p2: string | null }[][] = [];
    let current = players;
    while (current.length > 1) {
      const matches: { p1: string | null; p2: string | null }[] = [];
      for (let i = 0; i < current.length; i += 2) {
        matches.push({ p1: current[i], p2: current[i + 1] || null });
      }
      rounds.push(matches);
      current = matches.map((m) =>
        m.p1 !== null || m.p2 !== null ? 'ALIVE' : null,
      );
    }
    return rounds;
  }
}