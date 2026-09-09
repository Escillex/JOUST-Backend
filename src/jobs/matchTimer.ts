import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'prisma/prisma.service';
import { NotificationService } from 'src/notification/notification.service';
import {
  NotificationType,
  OrganizerInviteStatus,
} from '@prisma/client';

/**
 * Notifies the organizer(s) when a shared match timer reaches zero.
 *
 * The countdown itself is rendered client-side from `timerEndsAt`, so the server
 * needs its own trigger to notify even when no browser is watching. This sweep
 * finds running timers whose end has passed and haven't been notified yet, pings
 * the tournament's staff once, and flips `timerNotified` (+ stops the timer) so
 * it never fires twice. Cheap: the query is indexed on `timerRunning`.
 */
@Injectable()
export class MatchTimerJob {
  private readonly logger = new Logger(MatchTimerJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async handleCron() {
    const now = new Date();
    const expired = await this.prisma.matchUtilityState.findMany({
      where: {
        timerRunning: true,
        timerNotified: false,
        timerEndsAt: { lte: now },
      },
      select: {
        id: true,
        matchId: true,
        match: {
          select: {
            round: {
              select: {
                tournament: {
                  select: {
                    id: true,
                    name: true,
                    createdById: true,
                    organizers: {
                      where: { status: OrganizerInviteStatus.ACCEPTED },
                      select: { userId: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    for (const row of expired) {
      const tournament = row.match?.round?.tournament;
      // Flag first so a slow notification pass can't double-fire on the next tick.
      await this.prisma.matchUtilityState.update({
        where: { id: row.id },
        data: { timerNotified: true, timerRunning: false },
      });
      if (!tournament) continue;

      const recipients = new Set<string>();
      if (tournament.createdById) recipients.add(tournament.createdById);
      for (const o of tournament.organizers) recipients.add(o.userId);

      for (const userId of recipients) {
        await this.notifications.notify({
          userId,
          type: NotificationType.MATCH_TIMER_ENDED,
          title: `Match timer ended in ${tournament.name}`,
          body: 'A match countdown reached zero.',
          link: `/tournaments/${tournament.id}/live`,
          tournamentId: tournament.id,
        });
      }
    }

    if (expired.length > 0) {
      this.logger.log(`Match timer(s) ended: ${expired.length} notified.`);
    }
  }
}
