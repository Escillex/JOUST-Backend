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
