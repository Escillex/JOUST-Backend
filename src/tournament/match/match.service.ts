import {
  Injectable,
  BadRequestException,
  ForbiddenException,
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
  Prisma,
} from '@prisma/client';
import { NotificationService } from 'src/notification/notification.service';
import {
  effectiveRawConfig,
  resolveConfig,
  systemAllowsDraw,
  winsNeeded,
  type ByeResult,
  systemOf,
} from '../../Formats/format-config.helper';
import { completedMatchData } from './match-completion.helper';
import { applyMatchStats } from './match-stats.helper';
import { checkTournamentAccess } from '../../guards/tournament-access.util';
import {
  resolveScoreActor,
  type ScoreActor,
} from './scoring-permission.helper';
import type { JwtPayload } from '../../guards/jwt-auth.guard';
import { RealtimeGateway } from '../../realtime/realtime.gateway';

@Injectable()
export class MatchService {
  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => FormatsService))
    private formatsService: FormatsService,
    private notifications: NotificationService,
    private realtime: RealtimeGateway,
  ) {}

  /**
   * Credits (or — with `direction = -1` — reverses) the stats a completed match
   * earns. The delta math lives in `match-stats.helper.ts` so a grant, a reset
   * and a tournament-delete rollback all use the same authority: nothing else
   * ever recomputed a reset's reversal, which is exactly how phantom wins and
   * games used to sneak in (the old reset passed negative points but the
   * game/win/loss/draw deltas were hardcoded +1, so every reset RE-ADDED a win).
   * Wrapped in its own transaction here rather than in submitResult on purpose:
   * that cascades through handleMatchCompletion into bracket generation, which
   * would hold one transaction open across the whole chain.
   */
  private async updateMatchStats(
    matchId: string,
    pointsConfig: {
      pointsForWin: number;
      pointsForDraw: number;
      pointsForLoss: number;
    },
    // How a bye match credits its player. Only consulted when match.isBye; a real
    // result ignores it. Defaults to WIN so every existing caller is unchanged.
    byeResult: ByeResult = 'WIN',
    // 1 = grant, -1 = reverse (reset). All deltas scale with it.
    direction: 1 | -1 = 1,
  ) {
    await this.prisma.$transaction((tx) =>
      applyMatchStats(tx, matchId, pointsConfig, byeResult, direction),
    );
  }

  /**
   * Scores a completed bye match per the format's configurable `byeResult`. A bye
   * is a result the player never had to play for — in the points-scored systems
   * (Swiss, round robin, hybrid phase 1) it must still be credited, or the benched
   * player is silently penalised for an odd field they did not choose. Generated
   * byes are completed with a direct status write that bypasses `updateMatchStats`,
   * so nothing scored them; this restores it, honouring the organizer's choice:
   *   WIN  (default) - full points, +1 win, winner = the byed player.
   *   DRAW           - draw points, +1 draw, no winner recorded.
   *   NONE           - not counted; no points, no game, no winner.
   * Deliberately called only from the Swiss/round-robin bye sites: in an elimination
   * bracket a bye is not a played game and must not appear in a record. Idempotency:
   * call exactly once, at the point the bye is completed.
   */
  async creditBye(matchId: string): Promise<void> {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: {
        round: { include: { tournament: { include: { format: true } } } },
      },
    });
    if (!match?.isBye || match.status !== MatchStatus.COMPLETED) return;

    const config = resolveConfig(
      effectiveRawConfig(match.round.tournament),
      match.phase,
    );
    const byeResult = config.byeResult;

    // DRAW and NONE do not have a winner: a bye completed as a draw must not claim
    // one, and an uncounted bye should not read as a win anywhere it surfaces.
    if (byeResult !== 'WIN' && match.winnerId) {
      await this.prisma.match.update({
        where: { id: matchId },
        data: { winnerId: null },
      });
    }
    if (byeResult === 'NONE') return;

    await this.updateMatchStats(
      matchId,
      {
        pointsForWin: config.swissPointsForWin,
        pointsForDraw: config.swissPointsForDraw,
        pointsForLoss: config.swissPointsForLoss,
      },
      byeResult,
    );
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
  async reportDraw(matchId: string, user?: JwtPayload) {
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
    if (match.reportedWinnerId && !match.winnerId)
      throw new BadRequestException(
        'This match is awaiting organizer verification of its result',
      );

    const rawConfig = effectiveRawConfig(match.round.tournament);
    const config = resolveConfig(rawConfig, match.phase);
    if (!config.allowDraw)
      throw new BadRequestException('Draws are not allowed in this tournament');

    // The guard this method used to be missing (7.8 / 7.3).
    if (!systemAllowsDraw(systemOf(match.round.tournament), match.phase)) {
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

    // Staff may record a draw on the spot. A player of the match may not: a
    // draw carries no winner to defer into reportedWinnerId, so there would be
    // nothing for an organizer to verify — it must be confirmed by staff.
    const actor: ScoreActor = await resolveScoreActor(
      this.prisma,
      match,
      user,
      config.scoreSubmissionRule,
    );
    if (actor === 'PARTICIPANT') {
      throw new ForbiddenException('A draw must be confirmed by an organizer');
    }

    await this.prisma.match.update({
      where: { id: matchId },
      data: completedMatchData({ winnerId: null }),
    });

    await this.updateMatchStats(matchId, {
      pointsForWin: config.swissPointsForWin,
      pointsForDraw: config.swissPointsForDraw,
      pointsForLoss: config.swissPointsForLoss,
    });

    await this.formatsService.handleMatchCompletion(matchId);

    this.realtime.emitTournamentUpdated(match.round.tournamentId);

    return {
      matchComplete: true,
      draw: true,
      score: {
        player1: match.player1Score,
        player2: match.player2Score,
      },
    };
  }
  // ─── SELF-REPORT AND VERIFY (PLAYER SCORING) ────────────────

  async selfReportResult(
    matchId: string,
    winnerId: string | undefined,
    user: JwtPayload,
  ) {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: { round: { include: { tournament: true } } },
    });
    if (!match) throw new NotFoundException('Match not found');
    if (match.status === MatchStatus.COMPLETED)
      throw new BadRequestException('Match already completed');
    if (match.player1Id !== user.id && match.player2Id !== user.id)
      throw new ForbiddenException(
        'Only a player in this match may report a score',
      );
    if (winnerId) {
      const validPlayers = [match.player1Id, match.player2Id].filter(Boolean);
      if (!validPlayers.includes(winnerId))
        throw new BadRequestException('Winner must be in match');
    }

    const { scoreSubmissionRule } = resolveConfig(
      effectiveRawConfig(match.round.tournament),
      match.phase,
    );
    if (scoreSubmissionRule === 'STAFF_ONLY') {
      throw new ForbiddenException(
        'An organizer must submit scores in this tournament',
      );
    }

    await this.prisma.match.update({
      where: { id: matchId },
      data: { reportedWinnerId: winnerId || null },
    });

    if (winnerId) {
      await this.notifications.notifyTournamentOrganizers(
        match.round.tournamentId,
        {
          type: NotificationType.SCORE_PENDING,
          title: 'A player-scored result awaits your verification',
          body: 'Open the match to review and verify the reported winner.',
          link: `/tournaments/${match.round.tournamentId}/bracket`,
        },
      );
    }

    this.realtime.emitTournamentUpdated(match.round.tournamentId);

    return { message: 'Score reported successfully, pending verification' };
  }

  async verifyResult(matchId: string) {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
    });
    if (!match) throw new NotFoundException('Match not found');
    if (!match.reportedWinnerId)
      throw new BadRequestException('No reported score to verify');

    // This routes the verify step directly into the regular submitResult,
    // which advances the bracket and finalizes stats. It will also automatically
    // clear the reportedWinnerId because we updated completedMatchData.
    return this.submitResult(matchId, match.reportedWinnerId);
  }

  // A player's deciding game bumps the series score and closes its game log
  // before the result is verified. Undoing that decision — rejecting a pending
  // report on an ONGOING match, or resetting a COMPLETED match back to play —
  // must undo BOTH, or the tracker keeps declaring a winner while the match is
  // still being played. Completing a match means one side reached winsNeeded,
  // so subtracting one win (floored at 0) guarantees that side is no longer
  // decisive; reopening the deciding log hands the players back a live game.
  // A result carries no deciding log (a bare self/quick report or a draw) — it
  // only needs the score step skipped and the state `extra` still applied.
  private async undoDecidingResult(
    match: {
      id: string;
      player1Id: string | null;
      player2Id: string | null;
      player1Score: number;
      player2Score: number;
      gameLogs?: {
        id: string;
        gameNumber: number;
        trackerActive: boolean;
        winnerId: string | null;
        completedAt: Date | null;
      }[];
    },
    winnerId: string | null,
    extra: Partial<{
      reportedWinnerId: null;
      status: MatchStatus;
      winnerId: null;
      completedAt: null;
    }> = {},
    transaction?: Prisma.TransactionClient,
  ) {
    const decidingLog =
      winnerId &&
      match.gameLogs
        ?.filter(
          (log) =>
            !log.trackerActive && log.winnerId === winnerId && log.completedAt,
        )
        .sort((a, b) => b.gameNumber - a.gameNumber)[0];

    const undo = async (tx: Prisma.TransactionClient) => {
      const updated = await tx.match.update({
        where: { id: match.id },
        data: {
          ...extra,
          player1Score:
            winnerId === match.player1Id
              ? Math.max(0, match.player1Score - 1)
              : match.player1Score,
          player2Score:
            winnerId === match.player2Id
              ? Math.max(0, match.player2Score - 1)
              : match.player2Score,
        },
      });
      if (decidingLog) {
        await tx.matchGameLog.update({
          where: { id: decidingLog.id },
          data: { trackerActive: true, winnerId: null, completedAt: null },
        });
      }
      return updated;
    };
    return transaction ? undo(transaction) : this.prisma.$transaction(undo);
  }

  async rejectReportedResult(matchId: string) {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: { round: true, gameLogs: true },
    });
    if (!match) throw new NotFoundException('Match not found');
    if (!match.reportedWinnerId)
      throw new BadRequestException('No reported score to reject');
    if (match.status === MatchStatus.COMPLETED)
      throw new BadRequestException('Match already completed');

    await this.undoDecidingResult(match, match.reportedWinnerId, {
      reportedWinnerId: null,
    });

    await this.notifyPlayers(
      match,
      NotificationType.MATCH_RESULT,
      'The reported score was rejected by the organizer. Please re-enter the correct result.',
    );

    this.realtime.emitTournamentUpdated(match.round.tournamentId);

    return { message: 'Reported score rejected' };
  }

  async resetMatch(matchId: string) {
    const { match, reset } = await this.prisma.$transaction(
      async (tx) => {
        const match = await tx.match.findUnique({
          where: { id: matchId },
          include: {
            round: {
              include: {
                tournament: {
                  include: { format: true },
                },
              },
            },
            gameLogs: true,
          },
        });

        if (!match) throw new NotFoundException('Match not found');
        if (match.status !== MatchStatus.COMPLETED)
          throw new BadRequestException('Only completed matches can be reset');

        // A played dependent match cannot safely have its participants replaced.
        // Rebuild pending destinations from their feeders, which also repairs old
        // duplicate/stale slots left by previous reset/re-report cycles.
        const destinationIds = [
          match.nextMatchId,
          match.loserNextMatchId,
        ].filter((id): id is string => Boolean(id));
        const destinations = destinationIds.length
          ? await tx.match.findMany({ where: { id: { in: destinationIds } } })
          : [];
        if (
          destinations.some(
            (next) => next.status !== MatchStatus.PENDING || next.startedAt,
          )
        ) {
          throw new BadRequestException(
            'Cannot reset this result because a dependent match has already started.',
          );
        }

        const system = systemOf(match.round.tournament);
        // Swiss pairings/top cuts depend on the entire preceding round, not links.
        if (
          system === 'SWISS' ||
          (system === 'HYBRID' && match.phase === 1) ||
          (system === 'DOUBLE_ELIMINATION' && match.round.roundNumber === 200)
        ) {
          const laterRound = await tx.round.findFirst({
            where: {
              tournamentId: match.round.tournamentId,
              roundNumber: { gt: match.round.roundNumber },
            },
          });
          if (laterRound) {
            throw new BadRequestException(
              'Cannot reset this result after a dependent round has been generated.',
            );
          }
        }

        const rawConfig = effectiveRawConfig(match.round.tournament);
        const config = resolveConfig(rawConfig, match.phase);

        // Roll back stats awarded for this match
        await applyMatchStats(
          tx,
          matchId,
          {
            pointsForWin: config.swissPointsForWin,
            pointsForDraw: config.swissPointsForDraw,
            pointsForLoss: config.swissPointsForLoss,
          },
          config.byeResult,
          -1,
        );

        // Revert match status, clear winner/timestamps, and take back the deciding
        // game (series score −1 + the closed game log reopened) so the tracker does
        // not keep declaring a winner on an ONGOING match.
        const reset = await this.undoDecidingResult(
          match,
          match.winnerId,
          {
            status: MatchStatus.ONGOING,
            winnerId: null,
            completedAt: null,
            reportedWinnerId: null,
          },
          tx,
        );

        for (const next of destinations) {
          const feeders = await tx.match.findMany({
            where: {
              OR: [{ nextMatchId: next.id }, { loserNextMatchId: next.id }],
            },
            orderBy: { id: 'asc' },
          });
          const players = feeders.flatMap((feeder) => {
            if (feeder.status !== MatchStatus.COMPLETED || !feeder.winnerId)
              return [];
            const player =
              feeder.nextMatchId === next.id
                ? feeder.winnerId
                : feeder.player1Id === feeder.winnerId
                  ? feeder.player2Id
                  : feeder.player1Id;
            return player ? [player] : [];
          });
          if (players.length > 2 || new Set(players).size !== players.length) {
            throw new BadRequestException(
              'The downstream bracket has conflicting participants.',
            );
          }
          await tx.match.update({
            where: { id: next.id },
            data: {
              player1Id: players[0] ?? null,
              player2Id: players[1] ?? null,
            },
          });
        }

        // If tournament was marked COMPLETED, reopen it as ONGOING
        if (match.round.tournament.status === 'COMPLETED') {
          await tx.tournament.update({
            where: { id: match.round.tournamentId },
            data: {
              status: 'ONGOING',
              completedAt: null,
              winnerId: null,
            },
          });
        }
        return { match, reset };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.notifyPlayers(
      match,
      NotificationType.MATCH_RESULT,
      'Your match score has been reset by the organizer.',
    );

    this.realtime.emitTournamentUpdated(match.round.tournamentId);

    return { message: 'Match score reset successfully', match: reset };
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
    const config = resolveConfig(rawConfig, match.phase);
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
      !systemAllowsDraw(systemOf(match.round.tournament), match.phase)
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
      data: completedMatchData({ winnerId: winnerId || null }),
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

    this.realtime.emitTournamentUpdated(match.round.tournament.id);

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
   *
   * Authorization: the caller is resolved to STAFF (always allowed, result
   * final) or PARTICIPANT (a player of the match; only allowed when the
   * tournament's scoreSubmissionRule allows player scoring). A participant's
   * game that DECIDES the series is deferred instead of completed: the match
   * stays ONGOING with reportedWinnerId set, and an organizer's
   * POST /matches/:id/verify finalizes it.
   */
  async reportGameResult(
    matchId: string,
    gameWinnerId: string,
    user?: JwtPayload,
  ) {
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

    // A player-driven result already sits awaiting review — the series is
    // decided and nothing more may be recorded until staff verdict it.
    if (match.reportedWinnerId && !match.winnerId)
      throw new BadRequestException(
        'This match is awaiting organizer verification of its result',
      );

    const isP1 = gameWinnerId === match.player1Id;
    const isP2 = gameWinnerId === match.player2Id;
    if (!isP1 && !isP2)
      throw new BadRequestException(
        'Game winner is not a participant in this match',
      );

    const rawConfig = effectiveRawConfig(match.round.tournament);
    const config = resolveConfig(rawConfig, match.phase);
    const { bestOf } = config;
    const winsReq = winsNeeded(bestOf);

    // Whoever this caller is, only staff submissions finalize on the spot; a
    // participant triggering the deciding game defers (see the block below).
    const actor: ScoreActor = await resolveScoreActor(
      this.prisma,
      match,
      user,
      config.scoreSubmissionRule,
    );

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

      if (actor === 'PARTICIPANT') {
        // Player-driven series decision → pending verification, not completed.
        // The score stands and the bracket holds; an organizer's verifyResult
        // routes this winner through submitResult's normal finalize path.
        await this.prisma.match.update({
          where: { id: matchId },
          data: { reportedWinnerId: matchWinnerId },
        });

        await this.notifications.notifyTournamentOrganizers(
          match.round.tournamentId,
          {
            type: NotificationType.SCORE_PENDING,
            title: 'A player-scored result awaits your verification',
            body: 'Open the match to review and verify the reported winner.',
            link: `/tournaments/${match.round.tournamentId}/bracket`,
          },
        );

        this.realtime.emitTournamentUpdated(match.round.tournamentId);

        return {
          matchComplete: false,
          pendingVerification: true,
          winnerId: matchWinnerId,
          reportedWinnerId: matchWinnerId,
          score: { player1: p1Wins, player2: p2Wins },
          bestOf,
          winsNeeded: winsReq,
        };
      }

      await this.prisma.match.update({
        where: { id: matchId },
        data: completedMatchData({ winnerId: matchWinnerId }),
      });

      await this.updateMatchStats(matchId, {
        pointsForWin: config.swissPointsForWin,
        pointsForDraw: config.swissPointsForDraw,
        pointsForLoss: config.swissPointsForLoss,
      });

      await this.formatsService.handleMatchCompletion(matchId);

      this.realtime.emitTournamentUpdated(match.round.tournamentId);

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
      data: completedMatchData({ winnerId }),
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
        select: {
          game: { select: { name: true } },
          format: { select: { gameName: true } },
        },
      });
      const gameName =
        tournamentMeta?.game?.name ?? tournamentMeta?.format?.gameName ?? null;
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

    if (nextMatch.player1Id === winnerId || nextMatch.player2Id === winnerId)
      return;
    if (
      nextMatch.status !== MatchStatus.PENDING ||
      (nextMatch.player1Id && nextMatch.player2Id)
    ) {
      throw new BadRequestException(
        'Cannot advance into a started or full match',
      );
    }

    const slot = nextMatch.player1Id === null ? 'player1Id' : 'player2Id';
    const updated = await this.prisma.match.update({
      where: { id: nextMatchId },
      data: { [slot]: winnerId },
    });

    if (updated.player1Id && updated.player2Id) {
      // Both slots now filled. Auto-resolve only a walkover (active vs forfeited);
      // otherwise the match is left PENDING for the organizer to start explicitly
      // (POST /matches/:id/start). Match readiness is organizer-driven now, so
      // advancement no longer activates or notifies.
      await this.resolveForfeitedPairing(nextMatchId);
    } else if (updated.isBye && (updated.player1Id || updated.player2Id)) {
      await this.submitResult(nextMatchId, winnerId);
    }
  }

  async advanceLoser(loserId: string, nextMatchId: string) {
    const nextMatch = await this.prisma.match.findUnique({
      where: { id: nextMatchId },
    });
    if (!nextMatch) return;

    if (nextMatch.player1Id === loserId || nextMatch.player2Id === loserId)
      return;
    if (
      nextMatch.status !== MatchStatus.PENDING ||
      (nextMatch.player1Id && nextMatch.player2Id)
    ) {
      throw new BadRequestException(
        'Cannot advance into a started or full match',
      );
    }

    const slot = nextMatch.player1Id === null ? 'player1Id' : 'player2Id';
    const updated = await this.prisma.match.update({
      where: { id: nextMatchId },
      data: { [slot]: loserId },
    });

    if (updated.player1Id && updated.player2Id) {
      // Same as advanceWinner: fill the slot, auto-resolve only a walkover, and
      // otherwise leave the match PENDING for the organizer to start.
      await this.resolveForfeitedPairing(nextMatchId);
    } else if (updated.isBye && (updated.player1Id || updated.player2Id)) {
      await this.submitResult(nextMatchId, loserId);
    }
  }

  /**
   * PENDING → ONGOING, and the single point at which the two players are told
   * to come to the table (MATCH_READY). Nothing auto-activates any more, so this
   * is how every real match becomes playable, in every format. Byes/walkovers
   * never reach here — they resolve automatically and have no game to start.
   * Idempotent on an already-started match.
   *
   * Who may call it is a per-tournament rule (`matchStartWho`), defaulting to
   * the two players plus staff: organizer-only start suits a supervised venue
   * and gets in the way at a casual one, where the players are at the table and
   * the organizer is not. Decided here rather than in a guard for the same
   * reason player self-scoring is — the answer depends on the tournament's
   * configuration, which a guard does not read.
   */
  async startMatch(matchId: string, user?: JwtPayload) {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: {
        round: {
          include: {
            tournament: {
              select: {
                id: true,
                config: true,
                format: { select: { config: true } },
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
      throw new BadRequestException('A bye has no match to start');
    if (!match.player1Id || !match.player2Id)
      throw new BadRequestException(
        'Both players must be determined before the match can start',
      );

    const tournament = match.round?.tournament;
    if (!tournament) throw new NotFoundException('Match has no tournament');
    const { matchStartWho } = resolveConfig(
      effectiveRawConfig(tournament),
      match.phase,
    );
    const isParticipant =
      !!user?.id &&
      (user.id === match.player1Id || user.id === match.player2Id);
    const isStaff =
      (await checkTournamentAccess(this.prisma, tournament.id, user)) ===
      'ALLOWED';
    if (
      !isStaff &&
      !(matchStartWho === 'STAFF_AND_PARTICIPANTS' && isParticipant)
    ) {
      throw new ForbiddenException(
        isParticipant
          ? 'This tournament restricts starting a match to its organizers'
          : 'Only a player in this match or the tournament organizers can start it',
      );
    }
    if (match.status === MatchStatus.ONGOING) return match; // already started

    const updated = await this.prisma.match.update({
      where: { id: matchId },
      // startedAt is stamped once and never re-stamped: the early return above
      // makes this path single-shot, but a match can also have been advanced
      // into ONGOING first, and that earlier moment is the true start.
      data: {
        status: MatchStatus.ONGOING,
        ...(match.startedAt ? {} : { startedAt: new Date() }),
      },
      include: { round: { select: { tournamentId: true } } },
    });

    await this.notifyPlayers(
      updated,
      NotificationType.MATCH_READY,
      'Your match is ready',
      'It is your turn to play.',
    );

    this.realtime.emitTournamentUpdated(tournament.id);

    return updated;
  }

  async activateMatch(matchId: string) {
    // Unlike startMatch this has no early return, so it can run more than once
    // for the same match as feeders settle. Read the existing stamp first and
    // leave it alone if present — the first activation is the start.
    const existing = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { startedAt: true },
    });
    const updated = await this.prisma.match.update({
      where: { id: matchId },
      data: {
        status: MatchStatus.ONGOING,
        ...(existing?.startedAt ? {} : { startedAt: new Date() }),
      },
      include: { round: { select: { tournamentId: true } } },
    });

    // Note: no MATCH_READY here. Advancement (a match becoming *eligible* to play)
    // is not the same as the organizer *starting* it — with a handful of
    // organizers and many tables, pinging players the instant their feeders finish
    // is premature. "Your match is ready" now fires when the organizer opens the
    // tracker (TrackerService.openTracker, first game). See docs/history 2026-08-09.

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
        player1: {
          select: {
            id: true,
            username: true,
            displayName: true,
            isGuest: true,
          },
        },
        player2: {
          select: {
            id: true,
            username: true,
            displayName: true,
            isGuest: true,
          },
        },
        winner: {
          select: {
            id: true,
            username: true,
            displayName: true,
            isGuest: true,
          },
        },
      },
    });
  }

  async getMatchesByRound(roundId: string) {
    return this.prisma.match.findMany({
      where: { roundId },
      include: {
        player1: {
          select: {
            id: true,
            username: true,
            displayName: true,
            isGuest: true,
          },
        },
        player2: {
          select: {
            id: true,
            username: true,
            displayName: true,
            isGuest: true,
          },
        },
        winner: {
          select: {
            id: true,
            username: true,
            displayName: true,
            isGuest: true,
          },
        },
      },
    });
  }
}
