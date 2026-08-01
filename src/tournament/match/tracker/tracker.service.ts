import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
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

    const config = resolveConfig(effectiveRawConfig(match.round.tournament));

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

    return created;
  }

  async updateTracker(matchId: string, dto: UpdateTrackerDto) {
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

    // Close the log
    const log = await this.prisma.matchGameLog.update({
      where: { id: activeLog.id },
      data: {
        trackerActive: false,
        winnerId: dto.winnerId ?? null,
        completedAt: new Date(),
      },
    });

    // Report to the match service — increments player1Score/player2Score
    // and auto-completes the match when winsNeeded is reached
    let matchResult: any = null;
    if (dto.winnerId) {
      matchResult = await this.matchService.reportGameResult(
        matchId,
        dto.winnerId,
      );
    } else {
      matchResult = await this.matchService.reportDraw(matchId);
    }

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
