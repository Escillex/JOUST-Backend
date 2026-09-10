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
  ParticipantStatus,
} from '@prisma/client';
import { effectiveRawConfig, resolveConfig } from './format-config.helper';
import { seedBracketSlots, shuffled } from './bracket-seeding.helper';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { completedMatchData } from '../tournament/match/match-completion.helper';

@Injectable()
export class FormatsService {
  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => MatchService))
    private matchService: MatchService,
    @Inject(forwardRef(() => TournamentService))
    private tournamentService: TournamentService,
    private leaderboardService: LeaderboardService,
    private realtime: RealtimeGateway,
  ) {}

  async initializeTournamentFormat(
    tournamentId: string,
    format: TournamentFormat, // full entity from prisma
    playerIds: string[],
    activate: boolean = true,
  ) {
    const system = format.system;
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      select: { config: true },
    });
    const config = effectiveRawConfig({ config: tournament?.config, format });

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
      include: {
        round: { include: { tournament: { include: { format: true } } } },
      },
    });

    if (!match) return;

    const { tournament } = match.round;
    const system = tournament.format?.system;

    if (system === TournamentSystem.SINGLE_ELIMINATION) {
      if (match.nextMatchId && match.winnerId) {
        await this.matchService.advanceWinner(
          match.winnerId,
          match.nextMatchId,
        );
      }
      await this.checkSingleEliminationComplete(tournament.id, match.roundId);
    } else if (system === TournamentSystem.DOUBLE_ELIMINATION) {
      if (match.winnerId && match.nextMatchId) {
        await this.matchService.advanceWinner(
          match.winnerId,
          match.nextMatchId,
        );
      }
      if (match.loserNextMatchId) {
        const loserId =
          match.player1Id === match.winnerId
            ? match.player2Id
            : match.player1Id;
        if (loserId)
          await this.matchService.advanceLoser(loserId, match.loserNextMatchId);
      }
      // A winners-bracket bye produces no loser, so the losers-bracket match wired
      // to receive that loser can be left under-filled. Re-check the two matches
      // this completion fed: settleLosersStarvation walks over (or, if both feeders
      // were byes, kills) any losers match whose feeders are all resolved but which
      // has fewer than two players. Without this, double elimination with a
      // non-power-of-two field deadlocks — the losers bracket never resolves and the
      // grand final never happens. See settleLosersStarvation.
      if (match.nextMatchId)
        await this.settleLosersStarvation(match.nextMatchId);
      if (match.loserNextMatchId)
        await this.settleLosersStarvation(match.loserNextMatchId);

      // Plan 7.11. This used to call checkTournamentComplete — the ROUND ROBIN
      // checker — which decided the winner from the points leaderboard and
      // applied the 1st-place points-tie halt. In a bracket that is simply the
      // wrong question: the grand final decides the tournament, not a points
      // total. Worse, it reliably halted: every match awards swissPointsForWin,
      // so in an 8-player bracket the winners-bracket champion and the player
      // who reached the grand final through the losers bracket both finish on
      // 4 wins — an exact points tie with the person who just beat them.
      await this.checkDoubleEliminationComplete(tournament.id);
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
          await this.matchService.advanceWinner(
            match.winnerId,
            match.nextMatchId,
          );
        }
        await this.checkSingleEliminationComplete(tournament.id, match.roundId);
      }
    }

    // A match finished and the bracket may have advanced (new pairings, a new
    // Swiss round, or a completed tournament). Tell every viewer of this
    // tournament to refresh. This is a coarse signal, so emitting once here
    // covers all the branches above regardless of which system ran.
    this.realtime.emitTournamentUpdated(tournament.id);
  }

  /**
   * Resolves a losers-bracket match left under-filled by an upstream winners-bracket
   * bye. A bye produces no loser, so a losers match wired to receive that loser can
   * end up with one player — walk them over — or none — the match is dead, so
   * complete it with no winner and propagate the emptiness to whatever it fed.
   *
   * Only acts once *every* feeder of the match has completed, so it can never
   * pre-empt a slot that is still legitimately waiting for a player. Byes only
   * originate in winners round 1 (the bracket is padded to the next power of two and
   * the field is always more than half full), so that is the sole starvation source;
   * a fully-populated bracket never triggers this, and single elimination — whose
   * every non-first round always receives two winners — never does either.
   * Recursive down the losers side; idempotent (returns immediately once COMPLETED).
   */
  private async settleLosersStarvation(matchId: string): Promise<void> {
    const m = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: {
        previousMatches: { select: { status: true } }, // winner-feeders
        previousLoserMatches: { select: { status: true } }, // loser-feeders
      },
    });
    if (!m || m.status === MatchStatus.COMPLETED) return;

    const feeders = [...m.previousMatches, ...m.previousLoserMatches];
    // A match with no feeders is a round-1 match, which byes cannot starve.
    if (feeders.length === 0) return;
    if (!feeders.every((f) => f.status === MatchStatus.COMPLETED)) return;

    const players = [m.player1Id, m.player2Id].filter(Boolean) as string[];
    // Two players present: normally filled — the advance path activates it.
    if (players.length >= 2) return;

    if (players.length === 1) {
      // One real player, the other feeder was a bye: walk them over as a bye.
      // handleMatchCompletion then advances the winner and settles the next match.
      await this.prisma.match.update({
        where: { id: m.id },
        data: completedMatchData({ winnerId: players[0], isBye: true }),
      });
      await this.handleMatchCompletion(m.id);
      return;
    }

    // Zero players: both feeders delivered nobody. This match is dead — complete it
    // with no winner and push the emptiness on to whatever it fed.
    await this.prisma.match.update({
      where: { id: m.id },
      data: completedMatchData({ isBye: true }),
    });
    if (m.nextMatchId) await this.settleLosersStarvation(m.nextMatchId);
    if (m.loserNextMatchId)
      await this.settleLosersStarvation(m.loserNextMatchId);
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

  private async checkHybridPhase1Complete(
    tournamentId: string,
    roundId: string,
  ) {
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
    if (!tournament?.format) return;

    const config = effectiveRawConfig(tournament);
    // Read through the phase with a root fallback, so a flat (un-nested) config is
    // honoured too. resolveConfig's phase-1 merge gives swissRounds the same way;
    // topCutSize isn't in ResolvedConfig, so it's read directly with the same
    // nested-then-root precedence (F4 — the completion logic and resolveConfig
    // now agree on the config shape).
    const maxRounds =
      resolveConfig(config, 1).swissRounds ??
      config.swissRounds ??
      Math.max(1, Math.ceil(Math.log2(tournament.participants.length)));

    if (round.roundNumber < maxRounds) {
      // Keep running Swiss
      await this.generateNextSwissRound(tournamentId, round.roundNumber + 1, 1);
      return;
    }

    // Swiss phase complete — begin Top Cut
    const topCutSize =
      (config.phase2 as Record<string, any>)?.topCutSize ??
      config.topCutSize ??
      8;
    const leaderboard =
      await this.leaderboardService.getLeaderboard(tournamentId);
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

    await this.initSingleElimination(
      tournamentId,
      topN,
      true,
      nextRoundOffset,
      2,
    );
  }

  private async checkTournamentComplete(tournamentId: string) {
    // An already-completed tournament must not be re-completed: completeTournament
    // awards lifetime points and counters that cannot be undone. Checked here as
    // well as inside completeTournament so the winnerId write below is skipped too,
    // which would otherwise overwrite a manually resolved winner.
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      select: { status: true },
    });
    if (!tournament || tournament.status === TournamentStatus.COMPLETED) return;

    const allMatches = await this.prisma.match.findMany({
      where: { round: { tournamentId } },
    });
    const allDone =
      allMatches.length > 0 &&
      allMatches.every((m) => m.status === MatchStatus.COMPLETED);
    if (allDone) {
      const leaderboard =
        await this.leaderboardService.getLeaderboard(tournamentId);

      // --- MANUAL TIE-BREAKER OVERRIDE ---
      // If there's a tie for 1st place in points, halt auto-completion
      if (
        leaderboard.length > 1 &&
        leaderboard[0].points > 0 &&
        leaderboard[0].points === leaderboard[1].points
      ) {
        return; // Leave ONGOING so organizer can resolve tie
      }

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
    // Standard seeded placement. This used to pad with nulls at the end and pair
    // adjacently, which gave byes to the worst seeds, sat seeds 1 and 2 against
    // each other in round one, and produced unplayable both-slots-empty matches.
    // See bracket-seeding.helper.ts.
    const padded = seedBracketSlots(playerIds, bracketSize);
    const rounds = this.generateBracket(padded);

    let prevMatchIds: string[] = [];
    for (let i = 0; i < rounds.length; i++) {
      const round = await this.prisma.round.create({
        data: { tournamentId, roundNumber: roundOffset + i },
      });

      const currentMatchIds: string[] = [];
      for (let j = 0; j < rounds[i].length; j++) {
        const m = rounds[i][j];
        const created = await this.matchService.createMatch({
          roundId: round.id,
          player1Id: m.p1 && m.p1 !== 'ALIVE' ? m.p1 : undefined,
          player2Id: m.p2 && m.p2 !== 'ALIVE' ? m.p2 : undefined,
          isBye:
            (m.p1 === null && m.p2 !== null) ||
            (m.p1 !== null && m.p2 === null),
          phase,
          matchIndex: j,
        });
        currentMatchIds.push(created.id);

        if (i === 0 && activate) {
          if (created.player1Id && created.player2Id) {
            await this.matchService.activateMatch(created.id);
          } else if (
            created.isBye &&
            (created.player1Id || created.player2Id)
          ) {
            const winnerId = (created.player1Id || created.player2Id) as string;
            await this.prisma.match.update({
              where: { id: created.id },
              data: completedMatchData({ winnerId }),
            });
          }
        }
      }

      if (prevMatchIds.length > 0) {
        await this.matchService.linkMatches(prevMatchIds, currentMatchIds);
      }

      if (i === 0 && activate) {
        const r1Matches = await this.prisma.match.findMany({
          where: { roundId: round.id },
        });
        for (const rm of r1Matches) {
          if (rm.isBye && rm.status === MatchStatus.COMPLETED) {
            await this.handleMatchCompletion(rm.id);
          }
        }
      }

      prevMatchIds = currentMatchIds;
    }
  }

  /**
   * Completion for double elimination.
   *
   * Deliberately separate from checkTournamentComplete (plan 7.11). That
   * function ranks by accumulated match points and halts on a 1st-place points
   * tie, which is correct for standings-based systems (Swiss, round robin,
   * hybrid phase 1) and wrong for a bracket. No tie halt here: a bracket cannot tie.
   *
   * F15 — grand final bracket reset. When `grandFinalReset` is on (the default),
   * the winners-bracket finalist enters the grand final undefeated, so a single
   * loss must not eliminate them: if the losers-bracket finalist wins round 200, a
   * deciding reset match (round 201) is spawned and the winner of THAT is champion.
   * With reset off, round 200 decides it outright (the previous behaviour).
   */
  private async checkDoubleEliminationComplete(tournamentId: string) {
    const rounds = await this.prisma.round.findMany({
      where: { tournamentId, roundNumber: { in: [200, 201] } },
      include: { matches: true },
    });
    const grandFinal = rounds.find((r) => r.roundNumber === 200);
    const reset = rounds.find((r) => r.roundNumber === 201);
    if (!grandFinal) return;

    const gf = grandFinal.matches.find(
      (m) => m.status === MatchStatus.COMPLETED && m.winnerId,
    );
    if (!gf?.winnerId) return;

    // If a reset match exists, it is the decider — wait for it to be played.
    if (reset) {
      const rm = reset.matches.find(
        (m) => m.status === MatchStatus.COMPLETED && m.winnerId,
      );
      if (!rm?.winnerId) return; // reset created but not yet played
      await this.finishDoubleElimination(tournamentId, rm.winnerId);
      return;
    }

    // No reset yet. Does the configured format want one, and did the
    // losers-bracket finalist just win?
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: { format: true },
    });
    const { grandFinalReset } = resolveConfig(effectiveRawConfig(tournament));
    if (grandFinalReset) {
      const wbFinalist = await this.winnersFinalistId(
        grandFinal.matches[0]?.id,
      );
      // The winners-bracket finalist LOST the grand final: both now have one loss,
      // so play a deciding reset match rather than eliminate the undefeated player.
      if (wbFinalist && gf.winnerId !== wbFinalist) {
        await this.createGrandFinalReset(tournamentId, gf);
        return; // not complete until the reset is played
      }
    }

    // Single grand final, or the winners-bracket finalist won: they are champion.
    await this.finishDoubleElimination(tournamentId, gf.winnerId);
  }

  /** Records the winner and completes the tournament. */
  private async finishDoubleElimination(
    tournamentId: string,
    winnerId: string,
  ) {
    await this.prisma.tournament.update({
      where: { id: tournamentId },
      data: { winnerId },
    });
    await this.tournamentService.completeTournament(tournamentId);
  }

  /** The winners-bracket finalist: the winner of the grand final's winners-side
   *  feeder (a winners round, numbered < 100). */
  private async winnersFinalistId(
    grandFinalMatchId: string | undefined,
  ): Promise<string | null> {
    if (!grandFinalMatchId) return null;
    const gf = await this.prisma.match.findUnique({
      where: { id: grandFinalMatchId },
      include: {
        previousMatches: {
          select: { winnerId: true, round: { select: { roundNumber: true } } },
        },
      },
    });
    const winnersFeeder = gf?.previousMatches.find(
      (m) => m.round.roundNumber < 100,
    );
    return winnersFeeder?.winnerId ?? null;
  }

  /** Spawns the deciding reset match (round 201) with the two grand-final players.
   *  Left PENDING for the organizer to start, like every other match. */
  private async createGrandFinalReset(
    tournamentId: string,
    grandFinalMatch: Match,
  ): Promise<void> {
    const round = await this.prisma.round.create({
      data: { tournamentId, roundNumber: 201 },
    });
    await this.matchService.createMatch({
      roundId: round.id,
      player1Id: grandFinalMatch.player1Id ?? undefined,
      player2Id: grandFinalMatch.player2Id ?? undefined,
      isBye: false,
      matchIndex: 0,
    });
    this.realtime.emitTournamentUpdated(tournamentId);
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
    // Same seeded placement as single elimination — the winners bracket has the
    // same shape and the same reasons for wanting it.
    const padded = seedBracketSlots(playerIds, bracketSize);
    const k = Math.log2(bracketSize);

    // 1. Winners Bracket (Rounds 1 to k)
    const winnersMatchesPerRound = this.generateBracket(padded);
    const winnersMatchIds: string[][] = [];

    for (let i = 0; i < winnersMatchesPerRound.length; i++) {
      const round = await this.prisma.round.create({
        data: { tournamentId, roundNumber: i + 1 },
      });
      const ids: string[] = [];
      for (let j = 0; j < winnersMatchesPerRound[i].length; j++) {
        const m = winnersMatchesPerRound[i][j];
        const created = await this.matchService.createMatch({
          roundId: round.id,
          player1Id: m.p1 && m.p1 !== 'ALIVE' ? m.p1 : undefined,
          player2Id: m.p2 && m.p2 !== 'ALIVE' ? m.p2 : undefined,
          isBye:
            i === 0 &&
            ((m.p1 === null && m.p2 !== null) ||
              (m.p1 !== null && m.p2 === null)),
          matchIndex: j,
        });
        ids.push(created.id);
        if (i === 0 && activate) {
          if (created.player1Id && created.player2Id) {
            await this.matchService.activateMatch(created.id);
          } else if (created.isBye && created.player1Id) {
            await this.prisma.match.update({
              where: { id: created.id },
              data: completedMatchData({ winnerId: created.player1Id }),
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
          matchIndex: j,
        });
        ids.push(m.id);
      }
      losersMatchIds.push(ids);
    }

    // Link Losers matches (nextMatchId)
    for (let r = 0; r < losersMatchIds.length - 1; r++) {
      const isOneToOne =
        losersMatchIds[r].length === losersMatchIds[r + 1].length;
      await this.matchService.linkMatches(
        losersMatchIds[r],
        losersMatchIds[r + 1],
        isOneToOne,
      );
    }

    // Link Winners -> Losers (loserNextMatchId).
    // A two-player bracket has no losers rounds at all: k is 1, so the loop above
    // runs `r <= 2k-2` = 0 times and losersMatchIds is empty. Without this guard
    // the next line reads losersMatchIds[0][...] and throws, which took down every
    // 2-player double-elimination tournament. The grand-finals block below already
    // handles that case by dropping the winners-final loser straight into the
    // grand final, which is the correct shape for two players.
    if (losersMatchIds.length > 0) {
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
    }

    // 3. Grand Finals (Round 200)
    const gfRound = await this.prisma.round.create({
      data: { tournamentId, roundNumber: 200 },
    });
    const gfMatch = await this.matchService.createMatch({
      roundId: gfRound.id,
      isBye: false,
      matchIndex: 0,
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

      // Fix: The loser of the Winners Final MUST drop down into the Losers Final
      await this.prisma.match.update({
        where: { id: winnersFinalId },
        data: { loserNextMatchId: losersFinalId },
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

  private async initSwiss(
    tournamentId: string,
    playerIds: string[],
    activate: boolean = true,
    phase: number = 1,
  ) {
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
        matchIndex: i / 2,
      });
      matchesCreated.push(match);

      if (p1 && p2 && activate) await this.matchService.activateMatch(match.id);
      else if (p1 && !p2) {
        await this.prisma.match.update({
          where: { id: match.id },
          data: completedMatchData({ winnerId: p1 }),
        });
        // A Swiss bye counts as a win: award the round's points so the benched
        // player is not penalised for an odd field.
        await this.matchService.creditBye(match.id);
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

    const rawConfig = effectiveRawConfig(tournament);
    const config = resolveConfig(rawConfig);
    const maxRounds =
      config.swissRounds ??
      Math.max(1, Math.ceil(Math.log2(tournament!.participants.length)));

    if (round.roundNumber >= maxRounds) {
      const leaderboard =
        await this.leaderboardService.getLeaderboard(tournamentId);

      // --- MANUAL TIE-BREAKER OVERRIDE ---
      if (
        leaderboard.length > 1 &&
        leaderboard[0].points > 0 &&
        leaderboard[0].points === leaderboard[1].points
      ) {
        return; // Leave ONGOING so organizer can resolve tie
      }

      const winnerId = leaderboard.length > 0 ? leaderboard[0].userId : null;
      await this.prisma.tournament.update({
        where: { id: tournamentId },
        data: { winnerId },
      });
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

    // Skip players the organizer forfeited: they must not be paired in later rounds.
    const forfeited = await this.prisma.tournamentParticipant.findMany({
      where: { tournamentId, status: ParticipantStatus.FORFEITED },
      select: { userId: true },
    });
    const forfeitedIds = new Set(forfeited.map((p) => p.userId));
    const activeSortedIds = sortedIds.filter((id) => !forfeitedIds.has(id));

    const pairableIds = [...activeSortedIds];
    let byePlayer: string | null = null;

    if (pairableIds.length % 2 !== 0) {
      const eligibleByePlayers = activeSortedIds.filter(
        (playerId) => (byeCount.get(playerId) ?? 0) === 0,
      );
      byePlayer =
        eligibleByePlayers.length > 0
          ? eligibleByePlayers[eligibleByePlayers.length - 1]
          : activeSortedIds[activeSortedIds.length - 1];
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

    for (let i = 0; i < pairings.length; i++) {
      const [p1, p2] = pairings[i];
      const match = await this.matchService.createMatch({
        roundId: round.id,
        player1Id: p1,
        player2Id: p2,
        isBye: false,
        matchIndex: i,
      });
      matchesCreated.push(match);
      // Left PENDING: the organizer starts each new-round match explicitly. Nothing
      // auto-activates any more (see MatchService.startMatch).
    }

    if (byePlayer) {
      const byeMatch = await this.matchService.createMatch({
        roundId: round.id,
        player1Id: byePlayer,
        player2Id: undefined,
        isBye: true,
        matchIndex: pairings.length,
      });
      matchesCreated.push(byeMatch);
      await this.prisma.match.update({
        where: { id: byeMatch.id },
        data: completedMatchData({ winnerId: byePlayer }),
      });
      // Credit the bye as a win (round points) before the round can complete, so
      // the standings that drive the next pairing already reflect it.
      await this.matchService.creditBye(byeMatch.id);
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

  private async initRoundRobin(
    tournamentId: string,
    playerIds: string[],
    activate: boolean = true,
    roundOffset: number = 1,
  ) {
    const n = playerIds.length;
    const players = [...playerIds];
    if (n % 2 !== 0) players.push(null as any);
    const numRounds = players.length - 1;
    const half = players.length / 2;

    for (let r = 0; r < numRounds; r++) {
      const round = await this.prisma.round.create({
        data: { tournamentId, roundNumber: r + roundOffset },
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
            matchIndex: i,
          });
          if (activate) await this.matchService.activateMatch(match.id);
        } else if (p1 || p2) {
          const p = p1 || p2;
          const match = await this.matchService.createMatch({
            roundId: round.id,
            player1Id: p,
            isBye: true,
            matchIndex: i,
          });
          await this.prisma.match.update({
            where: { id: match.id },
            data: completedMatchData({ winnerId: p }),
          });
          // A round-robin bye counts as a win: award the round's points.
          await this.matchService.creditBye(match.id);
          if (activate) await this.handleMatchCompletion(match.id);
        }
      }
      players.splice(1, 0, players.pop()!);
    }
  }

  /** Delegates to the shared implementation so there is only one shuffle in the
   *  codebase. Kept as a method because callers here read better for it. */
  private shuffle(array: string[]): string[] {
    return shuffled(array);
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

  // ─── TIE BREAKER OVERRIDE ────────────────────────────────────

  async resolveTie(
    tournamentId: string,
    action: 'EXTEND_ROUND' | 'APPLY_TIEBREAKERS',
  ) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: { format: true },
    });
    if (!tournament) throw new BadRequestException('Tournament not found');

    const leaderboard =
      await this.leaderboardService.getLeaderboard(tournamentId);

    if (
      !(
        leaderboard.length > 1 &&
        leaderboard[0].points > 0 &&
        leaderboard[0].points === leaderboard[1].points
      )
    ) {
      throw new BadRequestException('No point tie for 1st place detected');
    }

    if (action === 'APPLY_TIEBREAKERS') {
      // Report the criterion that actually separated the top two. The old fixed
      // "via OMW%" message was wrong whenever a different tiebreaker decided it,
      // and outright misleading when none did and the order was simply whatever
      // the sort happened to produce.
      const rawConfig = effectiveRawConfig(tournament);
      const { tieBreakerOrder } = resolveConfig(rawConfig);
      const criterion = this.leaderboardService.tiebreakCriterion(
        leaderboard[0],
        leaderboard[1],
        tieBreakerOrder,
      );

      const winnerId = leaderboard[0].userId;
      await this.prisma.tournament.update({
        where: { id: tournamentId },
        data: { winnerId },
      });
      await this.tournamentService.completeTournament(tournamentId);

      return {
        message: criterion
          ? `Tie broken on ${criterion}.`
          : 'The configured tiebreakers could not separate these players. ' +
            'The winner was set to the current top of the standings — extend the ' +
            'round instead if you need this decided on results.',
        tiebreaker: criterion,
      };
    }

    if (action === 'EXTEND_ROUND') {
      const rounds = await this.prisma.round.findMany({
        where: { tournamentId },
        orderBy: { roundNumber: 'desc' },
        take: 1,
      });
      const nextRoundOffset = (rounds[0]?.roundNumber ?? 0) + 1;

      // Plan 7.10. This used to call initRoundRobin with only the tied players,
      // which was wrong three ways: it paired ONLY the tied players instead of
      // the whole field, it emitted a full round-robin cycle of n-1 rounds
      // (3 tied players produced 2 rounds, 4 produced 3) instead of the single
      // round an organizer asks for, and it used round-robin pairing even in a
      // Swiss event.
      //
      // generateNextSwissRound is what an extra round actually is: it pairs the
      // full active field by standings, skips FORFEITED players, assigns a bye
      // on an odd count preferring someone who has not had one, and falls back
      // to the closest-score repeat opponent when no-rematch cannot be
      // satisfied. The tie resolves because the leaders keep playing.
      //
      // Re-entry is already handled: the extra round sits above maxRounds, so
      // checkSwissRoundComplete takes its >= branch and re-checks the tie —
      // halting again for a further extension, or completing. Organizers can
      // extend repeatedly until it breaks.
      await this.generateNextSwissRound(tournamentId, nextRoundOffset);
      return {
        message:
          'Tiebreaker round generated. The full field has been paired by ' +
          'standings for one additional round.',
      };
    }

    throw new BadRequestException('Invalid tie-breaker action');
  }
}
