import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ModerationService } from './moderation.service';

/** Purges admin-removed gallery images and builds once their 30-day hold ends.
 *  Hourly like the guest cleanup: the deadline is a month out, so polling it
 *  every minute would be pointless work. */
@Injectable()
export class ModerationJob {
  private readonly logger = new Logger(ModerationJob.name);
  constructor(private readonly moderation: ModerationService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleCron() {
    try {
      await this.moderation.purgeExpired();
    } catch (err) {
      this.logger.error(`Removed-content purge failed: ${String(err)}`);
    }
  }
}
