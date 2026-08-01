import {
  Injectable,
  BadRequestException,
  NotFoundException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { FormatsService } from '../../Formats/formats.service';
import {
  MatchStatus,
  ParticipantStatus,
  NotificationType,
} from '@prisma/client';
import { NotificationService } from 'src/notification/notification.service';
import {
  effectiveRawConfig,
  resolveConfig,
  systemAllowsDraw,
  winsNeeded,
} from '../../Formats/format-config.helper';

@Injectable()
export class MatchService {
  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => FormatsService))
    private formatsService: FormatsService,
    private notifications: NotificationService,
  ) {}

  private async updateMatchStats(
    matchId: string,
    pointsConfig: {
      pointsForWin: number;
      pointsForDraw: number;
      pointsForLoss: number;
    },
  ) {
    // One transaction: this credits BOTH players. Half-applied, one player
    // has the match on their record and the other does not, and nothing
    // recomputes to notice. Every step is a plain write, so none of it needs
    // to sit outside. Wrapped here rather than in submitResult on purpose:
    // that cascades through handleMatchCompletion into bracket generation,
    // which would hold one transaction open across the whole chain.
    await this.prisma.$transaction(async (tx) => {
      const match = await tx.match.findUnique({
        where: { id: matchId },
        include: {
          round: {
            select: {
              tournamentId: true,
              tournament: { select: { format: { select: { system: true } } } },
            },
          },
          player1: { select: { id: true, isGuest: true } },
          player2: { select: { id: true, isGuest: true } },
        },
      });

      if (!match || !match.round || !match.player1Id) return;

      // Plan 8.1. Match points are the result only where standings ARE the
      // result. On a bracket the result is who won, and awarding points per win
      // actively caused harm: it is what let a hybrid pay the runner-up the
      // champion's global points (8b), and what made double elimination halt on
      // a phantom "tie for 1st" straight after a legitimate grand final (7.11).
      //
      // Win/loss/draw counters are deliberately NOT skipped — a win/loss record
      // matters in every system and feeds UserGlobalStats. Only the points
      // component is zeroed.
      const system = match.round.tournament?.format?.system;
      const pointsApply = !(
        system === 'SINGLE_ELIMINATION' ||
        system === 'DOUBLE_ELIMINATION' ||
        (system === 'HYBRID' && match.phase === 2)
      );
      const points = pointsApply
        ? pointsConfig
        : { pointsForWin: 0, pointsForDraw: 0, pointsForLoss: 0 };

      const participantIds = [match.player1Id, match.player2Id].filter(
        Boolean,
      ) as string[];
      const participants = await tx.tournamentParticipant.findMany({
        where: {
          tournamentId: match.round.tournamentId,
          userId: { in: participantIds },
        },
        include: {
          stats: true,
          user: { select: { isGuest: true } },
        },
      });

      const participantByUserId = new Map(
        participants.map((participant) => [participant.userId, participant]),
      );

      // Game bucket for per-game stats — null when the format has no designation
      const tournamentMeta = await tx.tournament.findUnique({
        where: { id: match.round.tournamentId },
        select: { format: { select: { gameName: true } } },
      });
      const gameName = tournamentMeta?.format?.gameName ?? null;

      const maybeUpdateGlobalStats = async (
        userId: string,
        isGuest: boolean,
        deltaGames: number,
        deltaWins: number,
        deltaLosses: number,
        deltaDraws: number,
      ) => {
        if (isGuest) return;

        const currentGlobal = await tx.userGlobalStats.findUnique({
          where: { userId },
        });

        const gamesPlayed = (currentGlobal?.gamesPlayed ?? 0) + deltaGames;
        const wins = (currentGlobal?.wins ?? 0) + deltaWins;
        const losses = (currentGlobal?.losses ?? 0) + deltaLosses;
        const draws = (currentGlobal?.draws ?? 0) + deltaDraws;
        const winRate = gamesPlayed > 0 ? wins / gamesPlayed : 0;

        if (currentGlobal) {
          await tx.userGlobalStats.update({
            where: { userId },
            data: {
              gamesPlayed,
              wins,
              losses,
              draws,
              winRate,
            },
          });
        } else {
          await tx.userGlobalStats.create({
            data: {
              userId,
              tournamentsPlayed: 0,
              tournamentsWon: 0,
              gamesPlayed,
              wins,
              losses,
              draws,
              winRate,
            },
          });
        }

        if (!gameName) return;

        const currentGame = await tx.userGameStats.findUnique({
          where: { userId_gameName: { userId, gameName } },
        });

        const gameGamesPlayed = (currentGame?.gamesPlayed ?? 0) + deltaGames;
        const gameWins = (currentGame?.wins ?? 0) + deltaWins;
        const gameWinRate =
          gameGamesPlayed > 0 ? gameWins / gameGamesPlayed : 0;

        await tx.userGameStats.upsert({
          where: { userId_gameName: { userId, gameName } },
          create: {
            userId,
            gameName,
            gamesPlayed: gameGamesPlayed,
            wins: gameWins,
            losses: deltaLosses,
            draws: deltaDraws,
            winRate: gameWinRate,
          },
          update: {
            gamesPlayed: gameGamesPlayed,
            wins: gameWins,
            losses: { increment: deltaLosses },
            draws: { increment: deltaDraws },
            winRate: gameWinRate,
          },
        });
      };

      const updateParticipant = async (
        userId: string,
        deltaGames: number,
        deltaWins: number,
        deltaLosses: number,
        deltaDraws: number,
        deltaPoints: number,
      ) => {
        const participant = participantByUserId.get(userId);
        if (!participant) return;

        let stats = participant.stats;
        if (!stats) {
          stats = await tx.tournamentParticipantStats.create({
            data: { participantId: participant.id },
          });
        }

        const gamesPlayed = stats.gamesPlayed + deltaGames;
        const wins = stats.wins + deltaWins;
        const losses = stats.losses + deltaLosses;
        const draws = stats.draws + deltaDraws;
        const winRate = gamesPlayed > 0 ? wins / gamesPlayed : 0;

        await tx.tournamentParticipantStats.update({
          where: { id: stats.id },
          data: {
            gamesPlayed,
            wins,
            losses,
            draws,
            points: { increment: deltaPoints },
            winRate,
          },
        });

        await maybeUpdateGlobalStats(
          userId,
          participant.user.isGuest,
          deltaGames,
          deltaWins,
          deltaLosses,
          deltaDraws,
        );
      };

      if (match.isBye) {
        await updateParticipant(
          match.player1Id,
          1,
          1,
          0,
          0,
          points.pointsForWin,
        );
        return;
      }

      if (!match.player2Id) return;

      if (!match.winnerId) {
        await Promise.all([
          updateParticipant(match.player1Id, 1, 0, 0, 1, points.pointsForDraw),
          updateParticipant(match.player2Id, 1, 0, 0, 1, points.pointsForDraw),
        ]);
        return;
      }

      if (match.winnerId === match.player1Id) {
        await Promise.all([
          updateParticipant(match.player1Id, 1, 1, 0, 0, points.pointsForWin),
          updateParticipant(match.player2Id, 1, 0, 1, 0, points.pointsForLoss),
        ]);
        return;
      }

      await Promise.all([
        updateParticipant(match.player1Id, 1, 0, 1, 0, points.pointsForLoss),
        updateParticipant(match.player2Id, 1, 1, 0, 0, points.pointsForWin),
      ]);
    });
  }

  // ─── CREATE / LINK ────────────────────────────────────────────

  async createMatch(dto: {
    roundId: string;
    player1Id?: string;
    player2Id?: string;
    isBye: boolean;
    phase?: number;
    matchIndex?: number;
  }) {
    return this.prisma.match.create({
      data: {
        roundId: dto.roundId,
        player1Id: dto.player1Id ?? null,
        player2Id: dto.player2Id ?? null,
        isBye: dto.isBye,
        phase: dto.phase ?? 1,
        matchIndex: dto.matchIndex ?? 0,
      },
    });
  }

  async linkMatches(
    previousIds: string[],
    nextIds: string[],
    isOneToOne: boolean = false,
  ) {
    for (let i = 0; i < previousIds.length; i++) {
      const nextMatchId = isOneToOne ? nextIds[i] : nextIds[Math.floor(i / 2)];
      await this.prisma.match.update({
        where: { id: previousIds[i] },
        data: { nextMatchId },
      });
    }
  }

  // ─── SUBMIT RESULT (direct / override) ───────────────────────

  /**
   * Direct result submission. Works for single-game matches or admin overrides.
   * For bestOf > 1 tournaments, use reportGameResult() instead to track
   * per-game scores; passing a winnerId here will still force-complete the match.
   */
  /**
   * Completes a match as a draw. Reached only from the live tracker, when a
   * tracked game closes with no winner — the public POST /matches/:id/draw
   * route was removed in plan 7.3.
   *
   * Its validation is now aligned with submitResult's draw path (that was the
   * other half of 7.3). It previously checked only `allowDraw`, which made it a
   * way around the per-system guard: a draw on an elimination bracket strands
   * the next slot forever, and in double elimination silently drops player 1
   * into losers with nobody advancing to winners.
   */
  async reportDraw(matchId: string) {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: {
        round: {
          include: {
            tournament: {
              include: {
                format: true,
              },
            },
          },
        },
      },
    });

    if (!match) throw new NotFoundException('Match not found');
    if (match.status === MatchStatus.COMPLETED)
      throw new BadRequestException('Match already completed');
    if (match.isBye) throw new BadRequestException('Cannot draw a bye match');

    const rawConfig = effectiveRawConfig(match.round.tournament);
    const config = resolveConfig(rawConfig);
    if (!config.allowDraw)
      throw new BadRequestException('Draws are not allowed in this tournament');

    // The guard this method used to be missing (7.8 / 7.3).
    if (!systemAllowsDraw(match.round.tournament.format?.system, match.phase)) {
      throw new BadRequestException(
        'Draws are not supported by this tournament system: a match here must ' +
          'produce a winner to advance the bracket.',
      );
    }

    if (config.bestOf > 1) {
      throw new BadRequestException(
        `This match is Best of ${config.bestOf}; a drawn series cannot be recorded.`,
      );
    }

    if (config.pointsThreshold > 0) {
      throw new BadRequestException(
        `This match requires a points threshold of ${config.pointsThreshold} to determine a winner`,
      );
    }

    await this.prisma.match.update({
      where: { id: matchId },
      data: { winnerId: null, status: MatchStatus.COMPLETED },
    });

    await this.updateMatchStats(matchId, {
      pointsForWin: config.swissPointsForWin,
      pointsForDraw: config.swissPointsForDraw,
      pointsForLoss: config.swissPointsForLoss,
    });

    await this.formatsService.handleMatchCompletion(matchId);

    return {
      matchComplete: true,
      draw: true,
      score: {
        player1: match.player1Score,
        player2: match.player2Score,
      },
    };
  }

  async submitResult(matchId: string, winnerId?: string) {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: {
        round: {
          include: {
            tournament: {
              include: { format: true },
            },
          },
        },
      },
    });

    if (!match) throw new NotFoundException('Match not found');
    if (match.status === MatchStatus.COMPLETED)
      throw new BadRequestException('Match already completed');

    if (winnerId) {
      const validPlayers = [match.player1Id, match.player2Id].filter(Boolean);
      if (!validPlayers.includes(winnerId))
        throw new BadRequestException('Winner must be in match');
    }

    const rawConfig = effectiveRawConfig(match.round.tournament);
    const config = resolveConfig(rawConfig);
    const {
      pointsThreshold,
      bestOf,
      allowDraw,
      tieBreakerOrder,
      progressionType,
    } = config;

    if (bestOf <= 0)
      throw new BadRequestException('bestOf must be a positive integer');

    if (!winnerId && !allowDraw)
      throw new BadRequestException(
        'Match must have a winner unless draws are explicitly allowed',
      );

    // Plan item 7.8. `allowDraw` is an unvalidated key on a free-form config
    // blob, so any organizer could PATCH it onto a single-elimination
    // tournament and submit a winnerless result. That does not merely look
    // wrong — it strands the bracket (single elim / hybrid top cut) or drops
    // player 1 into the losers bracket for no reason (double elim). The
    // frontend hides the Draw control for these systems; this is the guard that
    // actually makes it unreachable. See systemAllowsDraw for the per-system
    // reasoning.
    if (
      !winnerId &&
      !systemAllowsDraw(match.round.tournament.format?.system, match.phase)
    ) {
      throw new BadRequestException(
        'Draws are not supported by this tournament system: a match here must ' +
          'produce a winner to advance the bracket. Draws are available in ' +
          'Swiss, round robin, and the Swiss phase of a hybrid event.',
      );
    }

    if (pointsThreshold > 0 && !winnerId)
      throw new BadRequestException(
        `This match requires a points threshold of ${pointsThreshold} to determine a winner`,
      );

    // Guard: warn when submitting a direct result on a bestOf > 1 match
    // without a winnerId — scores would be lost. A winnerId forces completion.
    if (bestOf > 1 && !winnerId) {
      throw new BadRequestException(
        `This match is Best of ${bestOf}. Use POST /match/${matchId}/game-result ` +
          `to report game-by-game, or provide a winnerId to force-complete.`,
      );
    }

    const completed = await this.prisma.match.update({
      where: { id: matchId },
      data: { winnerId: winnerId || null, status: MatchStatus.COMPLETED },
      include: { round: { select: { tournamentId: true } } },
    });

    await this.notifyPlayers(
      completed,
      NotificationType.MATCH_RESULT,
      'A result was recorded in your match',
    );

    await this.updateMatchStats(matchId, {
      pointsForWin: config.swissPointsForWin,
      pointsForDraw: config.swissPointsForDraw,
      pointsForLoss: config.swissPointsForLoss,
    });

    await this.formatsService.handleMatchCompletion(matchId);

    return {
      message: 'Result submitted',
      match: completed,
      formatApplied: {
        pointsThreshold,
        bestOf,
        allowDraw,
        tieBreakerOrder,
        progressionType,
      },
    };
  }

  // ─── REPORT GAME RESULT (bestOf tracking) ────────────────────

  /**
   * Reports the winner of a single game/set within a bestOf match.
   * Increments that player's score and auto-completes the match once
   * one player reaches Math.ceil(bestOf / 2) wins.
   *
   * Example — Best of 3:
   *   winsNeeded = 2
   *   Game 1 → p1 wins → score 1-0  (match ongoing)
   *   Game 2 → p1 wins → score 2-0  (match complete, p1 wins)
   */
  async reportGameResult(matchId: string, gameWinnerId: string) {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: {
        round: {
          include: {
            tournament: {
              include: {
                format: true,
              },
            },
          },
        },
      },
    });

    if (!match) throw new NotFoundException('Match not found');
    if (match.status === MatchStatus.COMPLETED)
      throw new BadRequestException('Match already completed');
    if (match.isBye)
      throw new BadRequestException(
        'Cannot report game results for a bye match',
      );

    const isP1 = gameWinnerId === match.player1Id;
    const isP2 = gameWinnerId === match.player2Id;
    if (!isP1 && !isP2)
      throw new BadRequestException(
        'Game winner is not a participant in this match',
      );

    const rawConfig = effectiveRawConfig(match.round.tournament);
    const config = resolveConfig(rawConfig);
    const { bestOf } = config;
    const winsReq = winsNeeded(bestOf);

    // Increment the winning player's game score
    const updated = await this.prisma.match.update({
      where: { id: matchId },
      data: {
        player1Score: isP1 ? { increment: 1 } : undefined,
        player2Score: isP2 ? { increment: 1 } : undefined,
      },
    });

    const p1Wins = updated.player1Score;
    const p2Wins = updated.player2Score;

    // Check if the match is now decided
    if (p1Wins >= winsReq || p2Wins >= winsReq) {
      const matchWinnerId =
        p1Wins >= winsReq ? match.player1Id! : match.player2Id!;

      await this.prisma.match.update({
        where: { id: matchId },
        data: { winnerId: matchWinnerId, status: MatchStatus.COMPLETED },
      });

      await this.updateMatchStats(matchId, {
        pointsForWin: config.swissPointsForWin,
        pointsForDraw: config.swissPointsForDraw,
        pointsForLoss: config.swissPointsForLoss,
      });

      await this.formatsService.handleMatchCompletion(matchId);

      return {
        matchComplete: true,
        winnerId: matchWinnerId,
        score: { player1: p1Wins, player2: p2Wins },
        bestOf,
        winsNeeded: winsReq,
      };
    }

    // Match still ongoing — return current state
    return {
      matchComplete: false,
      score: { player1: p1Wins, player2: p2Wins },
      bestOf,
      winsNeeded: winsReq,
      remaining: winsReq - Math.max(p1Wins, p2Wins),
    };
  }

  // ─── REPORT DRAW ─────────────────────────────────────────────

  /**
   * Completes a match as a draw (no winnerId).
   * Only permitted when allowDraw is true in the tournament's format.
   */
  // ─── WALKOVER (organizer forfeit/replace) ────────────────────

  /**
   * Completes a match by awarding one player the win without crediting the
   * other any game. Used when an organizer forfeits a player: the opponent
   * gets a normal win, the forfeiter gains no phantom losses/games.
   * Propagation through the bracket is identical to a normal result.
   */
  async completeAsWalkover(matchId: string, winnerId: string): Promise<void> {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
    });
    if (!match || match.status === MatchStatus.COMPLETED) return;

    await this.prisma.match.update({
      where: { id: matchId },
      data: { winnerId, status: MatchStatus.COMPLETED },
    });

    await this.creditWalkoverWin(matchId, winnerId);

    await this.formatsService.handleMatchCompletion(matchId);
  }

  /**
   * Credits the winner's per-tournament stats with a win (mirroring the
   * winner branch of updateMatchStats), then — for non-guest winners — the
   * same lifetime UserGlobalStats and per-game UserGameStats credit that a
   * normal result gets via updateMatchStats' maybeUpdateGlobalStats closure.
   * A walkover must read as a genuinely normal win everywhere the winner's
   * stats surface (tournament standings, profile, leaderboards). The
   * forfeiting opponent's stats are intentionally left untouched anywhere —
   * a walkover is not a game they played.
   */
  private async creditWalkoverWin(
    matchId: string,
    winnerId: string,
  ): Promise<void> {
    // Same reasoning as updateMatchStats: the per-tournament, global and
    // per-game credits for a walkover win must all land or none of them.
    await this.prisma.$transaction(async (tx) => {
      const match = await tx.match.findUnique({
        where: { id: matchId },
        include: { round: { select: { tournamentId: true } } },
      });
      if (!match || !match.round) return;

      const tournamentId = match.round.tournamentId;

      const participant = await tx.tournamentParticipant.findUnique({
        where: {
          userId_tournamentId: { userId: winnerId, tournamentId },
        },
        include: { stats: true, user: { select: { isGuest: true } } },
      });
      if (!participant) return;

      let stats = participant.stats;
      if (!stats) {
        stats = await tx.tournamentParticipantStats.create({
          data: { participantId: participant.id },
        });
      }

      const gamesPlayed = stats.gamesPlayed + 1;
      const wins = stats.wins + 1;
      const winRate = gamesPlayed > 0 ? wins / gamesPlayed : 0;

      await tx.tournamentParticipantStats.update({
        where: { id: stats.id },
        data: { gamesPlayed, wins, winRate },
      });

      // Guests never get lifetime/game stats — same skip as the normal path.
      if (participant.user.isGuest) return;

      const currentGlobal = await tx.userGlobalStats.findUnique({
        where: { userId: winnerId },
      });

      const globalGamesPlayed = (currentGlobal?.gamesPlayed ?? 0) + 1;
      const globalWins = (currentGlobal?.wins ?? 0) + 1;
      const globalLosses = currentGlobal?.losses ?? 0;
      const globalDraws = currentGlobal?.draws ?? 0;
      const globalWinRate =
        globalGamesPlayed > 0 ? globalWins / globalGamesPlayed : 0;

      if (currentGlobal) {
        await tx.userGlobalStats.update({
          where: { userId: winnerId },
          data: {
            gamesPlayed: globalGamesPlayed,
            wins: globalWins,
            losses: globalLosses,
            draws: globalDraws,
            winRate: globalWinRate,
          },
        });
      } else {
        await tx.userGlobalStats.create({
          data: {
            userId: winnerId,
            tournamentsPlayed: 0,
            tournamentsWon: 0,
            gamesPlayed: globalGamesPlayed,
            wins: globalWins,
            losses: globalLosses,
            draws: globalDraws,
            winRate: globalWinRate,
          },
        });
      }

      const tournamentMeta = await tx.tournament.findUnique({
        where: { id: tournamentId },
        select: { format: { select: { gameName: true } } },
      });
      const gameName = tournamentMeta?.format?.gameName ?? null;
      if (!gameName) return;

      const currentGame = await tx.userGameStats.findUnique({
        where: { userId_gameName: { userId: winnerId, gameName } },
      });

      const gameGamesPlayed = (currentGame?.gamesPlayed ?? 0) + 1;
      const gameWins = (currentGame?.wins ?? 0) + 1;
      const gameWinRate = gameGamesPlayed > 0 ? gameWins / gameGamesPlayed : 0;

      await tx.userGameStats.upsert({
        where: { userId_gameName: { userId: winnerId, gameName } },
        create: {
          userId: winnerId,
          gameName,
          gamesPlayed: gameGamesPlayed,
          wins: gameWins,
          losses: 0,
          draws: 0,
          winRate: gameWinRate,
        },
        update: {
          gamesPlayed: gameGamesPlayed,
          wins: gameWins,
          losses: { increment: 0 },
          draws: { increment: 0 },
          winRate: gameWinRate,
        },
      });
    });
  }

  // ─── FORFEIT AUTO-RESOLUTION ──────────────────────────────────

  /** After a slot is filled, resolve the match automatically if it now pits an
   *  active player against a forfeited one: the active player wins by walkover.
   *  This is what lets a forfeit terminate cleanly in every format, including a
   *  double-elimination loser dropping into the losers bracket. */
  async resolveForfeitedPairing(matchId: string): Promise<void> {
    // Round included here (rather than a second tournamentIdForMatch lookup)
    // so this only costs one DB round-trip for the match itself.
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: { round: { select: { tournamentId: true } } },
    });
    if (!match || match.status === MatchStatus.COMPLETED) return;
    if (!match.player1Id || !match.player2Id) return;

    const tId = match.round?.tournamentId;
    if (!tId) return;
    const statuses = await this.prisma.tournamentParticipant.findMany({
      where: {
        tournamentId: tId,
        userId: { in: [match.player1Id, match.player2Id] },
      },
      select: { userId: true, status: true },
    });
    const isForfeited = (uid: string) =>
      statuses.find((s) => s.userId === uid)?.status ===
      ParticipantStatus.FORFEITED;

    const p1Out = isForfeited(match.player1Id);
    const p2Out = isForfeited(match.player2Id);
    if (p1Out === p2Out) return; // both active or both forfeited: nothing to auto-resolve here
    const winnerId = p1Out ? match.player2Id : match.player1Id;
    await this.completeAsWalkover(matchId, winnerId);
  }

  // ─── ADVANCEMENT ─────────────────────────────────────────────

  async advanceWinner(winnerId: string, nextMatchId: string) {
    const nextMatch = await this.prisma.match.findUnique({
      where: { id: nextMatchId },
    });
    if (!nextMatch) return;

    const slot = nextMatch.player1Id === null ? 'player1Id' : 'player2Id';
    const updated = await this.prisma.match.update({
      where: { id: nextMatchId },
      data: { [slot]: winnerId },
    });

    if (updated.player1Id && updated.player2Id) {
      await this.resolveForfeitedPairing(nextMatchId);
      const after = await this.prisma.match.findUnique({
        where: { id: nextMatchId },
        select: { status: true },
      });
      if (after?.status !== MatchStatus.COMPLETED) {
        await this.activateMatch(nextMatchId);
      }
    } else if (updated.isBye && (updated.player1Id || updated.player2Id)) {
      await this.submitResult(nextMatchId, winnerId);
    }
  }

  async advanceLoser(loserId: string, nextMatchId: string) {
    const nextMatch = await this.prisma.match.findUnique({
      where: { id: nextMatchId },
    });
    if (!nextMatch) return;

    const slot = nextMatch.player1Id === null ? 'player1Id' : 'player2Id';
    const updated = await this.prisma.match.update({
      where: { id: nextMatchId },
      data: { [slot]: loserId },
    });

    if (updated.player1Id && updated.player2Id) {
      await this.resolveForfeitedPairing(nextMatchId);
      const after = await this.prisma.match.findUnique({
        where: { id: nextMatchId },
        select: { status: true },
      });
      if (after?.status !== MatchStatus.COMPLETED) {
        await this.activateMatch(nextMatchId);
      }
    } else if (updated.isBye && (updated.player1Id || updated.player2Id)) {
      await this.submitResult(nextMatchId, loserId);
    }
  }

  async activateMatch(matchId: string) {
    const updated = await this.prisma.match.update({
      where: { id: matchId },
      data: { status: MatchStatus.ONGOING },
      include: { round: { select: { tournamentId: true } } },
    });

    // Both players are told their match is live. Guests are filtered inside the
    // notification service, so no check is needed here.
    await this.notifyPlayers(
      updated,
      NotificationType.MATCH_READY,
      'Your match is ready',
      'It is your turn to play.',
    );

    return updated;
  }

  /** Shared notification helper for the two match events that concern the two
   *  players. Silently does nothing when neither slot is filled yet. */
  private async notifyPlayers(
    match: {
      player1Id: string | null;
      player2Id: string | null;
      round?: { tournamentId: string } | null;
    },
    type: NotificationType,
    title: string,
    body?: string,
  ): Promise<void> {
    const tournamentId = match.round?.tournamentId;
    if (!tournamentId) return;

    const recipients = [match.player1Id, match.player2Id].filter(
      (id): id is string => !!id,
    );
    await this.notifications.notifyMany(recipients, {
      type,
      title,
      body,
      link: `/tournaments/${tournamentId}/bracket`,
      tournamentId,
    });
  }

  // ─── QUERIES ─────────────────────────────────────────────────

  async getMatch(matchId: string) {
    return this.prisma.match.findUnique({
      where: { id: matchId },
      include: {
        player1: { select: { id: true, username: true, isGuest: true } },
        player2: { select: { id: true, username: true, isGuest: true } },
        winner: { select: { id: true, username: true, isGuest: true } },
      },
    });
  }

  async getMatchesByRound(roundId: string) {
    return this.prisma.match.findMany({
      where: { roundId },
      include: {
        player1: { select: { id: true, username: true, isGuest: true } },
        player2: { select: { id: true, username: true, isGuest: true } },
        winner: { select: { id: true, username: true, isGuest: true } },
      },
    });
  }
}
