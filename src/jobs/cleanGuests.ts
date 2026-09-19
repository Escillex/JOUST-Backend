import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuthService } from 'src/auth/auth.service';

/** One retention policy, including champions. Event records remain historical;
 * expired identities cannot be claimed and their handles are released. */
@Injectable()
export class CleanGuestsJob {
  constructor(private readonly authService: AuthService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleCron() {
    await this.authService.purgeExpiredGuests();
  }
}
