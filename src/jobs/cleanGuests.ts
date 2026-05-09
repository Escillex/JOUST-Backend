import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'prisma/prisma.service';

@Injectable()
export class CleanGuestsJob {
  private readonly logger = new Logger(CleanGuestsJob.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async handleCron() {
    await this.cleanOrphanedGuests();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async handleTimedCleanup() {
    const now = new Date();
    const tournaments = await this.prisma.tournament.findMany({
      where: {
        guestCleanupAt: {
          lte: now,
          not: null,
        },
      },
      select: {
        id: true,
        participants: {
          where: {
            user: {
              isGuest: true,
            },
          },
          select: { userId: true },
        },
      },
    });

    for (const t of tournaments) {
      const guestIds = t.participants.map(p => p.userId);
      if (guestIds.length > 0) {
        // Re-check each user is still a guest (could have been upgraded)
        const stillGuests = await this.prisma.user.findMany({
          where: {
            id: { in: guestIds },
            isGuest: true,
          },
          select: { id: true }
        });
        const toDelete = stillGuests.map(g => g.id);

        if (toDelete.length > 0) {
          await this.prisma.user.deleteMany({
            where: { id: { in: toDelete } },
          });
          this.logger.log(`Tournament ${t.id}: Purged ${toDelete.length} guests.`);
        }
      }

      // Clear the cleanup marker
      await this.prisma.tournament.update({
        where: { id: t.id },
        data: { guestCleanupAt: null },
      });
    }
  }

  async cleanOrphanedGuests() {
    this.logger.log('Starting cleanup of orphaned guest accounts...');

    // Find users who are guests AND have no associated Participant rows
    const deleted = await this.prisma.user.deleteMany({
      where: {
        isGuest: true,
        participatedTournaments: {
          none: {},
        },
      },
    });

    this.logger.log(`Cleanup complete. Deleted ${deleted.count} orphaned guest accounts.`);

    return deleted.count;
  }
}
