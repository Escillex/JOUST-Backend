import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { checkTournamentAccess } from '../../../guards/tournament-access.util';
import type { JwtPayload } from '../../../guards/jwt-auth.guard';
import { MatchService } from '../match.service';
import {
  effectiveRawConfig,
  resolveConfig,
} from '../../../Formats/format-config.helper';
import {
  OpenTrackerDto,
  UpdateTrackerDto,
  SubmitGameDto,
} from './dto/tracker.dto';
import { GameTrackingMode } from '@prisma/client';
import { RealtimeGateway } from '../../../realtime/realtime.gateway';

@Injectable()
export class TrackerService {
  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => MatchService))
    private matchService: MatchService,
    private realtime: RealtimeGateway,
  ) {}

  /** Finds which tournament a match belongs to so live updates can be sent to
   *  that tournament's room. Used by the update/submit paths, which otherwise
   *  only know the match id. */
  private async resolveTournamentId(
    matchId: string,
  ): Promise<string | undefined> {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { round: { select: { tournamentId: true } } },
    });
    return match?.round.tournamentId;
  }

  async openTracker(matchId: string, dto: OpenTrackerDto) {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: {
        round: {
          include: {
            tournament: { include: { format: true } },
          },
        },
        gameLogs: true,
      },
    });

    if (!match) throw new NotFoundException('Match not found');
    if (match.status !== 'ONGOING')
      throw new BadRequestException(
        'Tracker can only be opened on an ONGOING match',
      );
    if (match.isBye)
      throw new BadRequestException('Cannot open tracker on a bye match');

    const activeLog = match.gameLogs.find((l) => l.trackerActive);
    if (activeLog)
      throw new BadRequestException(
        `Game ${activeLog.gameNumber} tracker is already active. Submit it before opening the next.`,
      );

    const config = resolveConfig(
      effectiveRawConfig(match.round.tournament),
      match.phase,
    );

    // Resolve mode — dto > format config > default 'POINTS'
    const mode: GameTrackingMode =
      dto.mode ??
      (config.trackingMode as GameTrackingMode) ??
      GameTrackingMode.POINTS;

    // Resolve startingValue — dto > format config > auto-derive from bestOf
    const startingValue =
      dto.startingValue ?? config.defaultStartingValue ?? config.bestOf;

    const gameNumber = match.gameLogs.length + 1;

    const created = await this.prisma.matchGameLog.create({
      data: {
        matchId,
        gameNumber,
        mode,
        startingValue,
        player1Value: mode === GameTrackingMode.HP ? startingValue : 0,
        player2Value: mode === GameTrackingMode.HP ? startingValue : 0,
        trackerActive: true,
      },
    });

    // A new game log started. Signal the tournament room so any open tracker
    // panel refetches its log list and shows the new game.
    this.realtime.emitTournamentUpdated(match.round.tournament.id);

    // MATCH_READY is no longer sent here. It now fires when the organizer STARTS
    // the match (MatchService.startMatch) — the single organizer-driven moment a
    // match becomes playable. Opening the tracker is a later, separate step (and a
    // match must already be ONGOING to open one), so pinging here would double-notify.

    return created;
  }

  async updateTracker(
    matchId: string,
    dto: UpdateTrackerDto,
    user: JwtPayload,
  ) {
    // Authorization is done here rather than by TournamentAccessGuard, because the
    // rule depends on *who* the user is relative to the match. Two roles may write
    // live values (todo.md / parity): the tournament's staff (creator/admin/
    // co-organizer), who may set either side; and a *participant of this match*,
    // who may set only their OWN slot. This restores the player self-scoring the
    // frontend was always built for — organizers keep final say, since opening the
    // tracker and submitting the game result stay staff-only. Guests can't
    // authenticate, so they never reach here and stay organizer-driven.
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: {
        player1Id: true,
        player2Id: true,
        round: { select: { tournamentId: true } },
      },
    });
    if (!match) throw new NotFoundException('Match not found');

    const matchTournamentId = match.round?.tournamentId;
    const isStaff =
      !!matchTournamentId &&
      (await checkTournamentAccess(this.prisma, matchTournamentId, user)) ===
        'ALLOWED';

    if (!isStaff) {
      const isP1 = !!user?.id && user.id === match.player1Id;
      const isP2 = !!user?.id && user.id === match.player2Id;
      if (!isP1 && !isP2) {
        throw new ForbiddenException(
          'Only a player in this match or the tournament organizer can update the tracker',
        );
      }
      // A participant may move only their own number. Writing the opponent's slot
      // is a staff-only action (the organizer verifies both sides).
      if (isP1 && dto.player2Value !== undefined) {
        throw new ForbiddenException('You can only update your own value');
      }
      if (isP2 && dto.player1Value !== undefined) {
        throw new ForbiddenException('You can only update your own value');
      }
    }

    const activeLog = await this.prisma.matchGameLog.findFirst({
      where: { matchId, trackerActive: true },
    });

    if (!activeLog)
      throw new BadRequestException('No active tracker for this match');

    const updated = await this.prisma.matchGameLog.update({
      where: { id: activeLog.id },
      data: {
        ...(dto.player1Value !== undefined && {
          player1Value: dto.player1Value,
        }),
        ...(dto.player2Value !== undefined && {
          player2Value: dto.player2Value,
        }),
      },
    });

    // High-frequency live values: broadcast the new numbers directly so open
    // tracker panels move their HP/points bars without a full refetch.
    const tournamentId = await this.resolveTournamentId(matchId);
    if (tournamentId) {
      this.realtime.emitTrackerUpdate(tournamentId, {
        matchId,
        player1Value: updated.player1Value,
        player2Value: updated.player2Value,
        gameNumber: updated.gameNumber,
      });
    }

    return updated;
  }

  async submitGame(matchId: string, dto: SubmitGameDto) {
    const activeLog = await this.prisma.matchGameLog.findFirst({
      where: { matchId, trackerActive: true },
    });

    if (!activeLog)
      throw new BadRequestException('No active tracker to submit');

    // Record the result FIRST. reportGameResult / reportDraw validate the submit
    // (a winner-less draw on a bestOf>1, elimination, points-threshold, or
    // allowDraw:false match all throw here) before writing anything. Only once
    // that has succeeded do we close the log below. The old order closed the log
    // first, so an invalid draw left an orphaned "completed" game with no result
    // and no active tracker to retry (F5). We deliberately do NOT wrap the two in
    // one transaction: the result path cascades through handleMatchCompletion into
    // bracket generation, which the codebase intentionally keeps out of a single
    // long transaction — so ordering, not a transaction, is what guarantees the
    // log is never closed until the result is committed.
    let matchResult: any = null;
    if (dto.winnerId) {
      matchResult = await this.matchService.reportGameResult(
        matchId,
        dto.winnerId,
      );
    } else {
      matchResult = await this.matchService.reportDraw(matchId);
    }

    // Result is committed — now close the game log.
    const log = await this.prisma.matchGameLog.update({
      where: { id: activeLog.id },
      data: {
        trackerActive: false,
        winnerId: dto.winnerId ?? null,
        completedAt: new Date(),
      },
    });

    // The game closed and the series score changed (and the match may have
    // completed, which advances the bracket). Signal the tournament room so
    // tracker panels and bracket views refresh. Note: when this game finishes
    // the whole match, match completion also emits its own update, which is a
    // harmless duplicate refresh nudge.
    const tournamentId = await this.resolveTournamentId(matchId);
    if (tournamentId) {
      this.realtime.emitTournamentUpdated(tournamentId);
    }

    return { log, matchResult };
  }

  async getTrackerLogs(matchId: string) {
    return this.prisma.matchGameLog.findMany({
      where: { matchId },
      orderBy: { gameNumber: 'asc' },
    });
  }
}
