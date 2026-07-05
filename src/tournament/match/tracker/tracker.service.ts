import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { MatchService } from '../match.service';
import { resolveConfig } from '../../../Formats/format-config.helper';
import {
  OpenTrackerDto,
  UpdateTrackerDto,
  SubmitGameDto,
} from './dto/tracker.dto';
import { GameTrackingMode } from '@prisma/client';

@Injectable()
export class TrackerService {
  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => MatchService))
    private matchService: MatchService,
  ) {}

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
      (match.round.tournament.format?.config as Record<string, any>) ?? {},
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

    return this.prisma.matchGameLog.create({
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
  }

  async updateTracker(matchId: string, dto: UpdateTrackerDto) {
    const activeLog = await this.prisma.matchGameLog.findFirst({
      where: { matchId, trackerActive: true },
    });

    if (!activeLog)
      throw new BadRequestException('No active tracker for this match');

    return this.prisma.matchGameLog.update({
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

    return { log, matchResult };
  }

  async getTrackerLogs(matchId: string) {
    return this.prisma.matchGameLog.findMany({
      where: { matchId },
      orderBy: { gameNumber: 'asc' },
    });
  }
}
