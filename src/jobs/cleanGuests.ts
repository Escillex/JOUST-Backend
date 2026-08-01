import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'prisma/prisma.service';
import { AuthService } from 'src/auth/auth.service';

/**
 * The single scheduled cleanup for guest accounts.
 *
 * This used to be four separate crons across two files — 2 AM and every-minute
 * here, midnight and hourly in AuthService — which overlapped heavily and made
 * it impossible to tell which one had actually deleted an account. They are now
 * one hourly pass with four ordered phases.
 *
 * Hourly is deliberate. The only latency-sensitive phase is the scheduled
 * cleanup, and that deadline is set GUEST_EXPIRY_DAYS (30 days) in advance, so
 * polling it once a minute was 1,440 queries a day to watch a month-long timer.
 */
@Injectable()
export class CleanGuestsJob {
  private readonly logger = new Logger(CleanGuestsJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleCron() {
    await this.markExpiredGuests();
    await this.processScheduledCleanups();
    await this.cleanOrphanedGuests();
    await this.cleanStaleCompletedGuests();
  }

  /** Phase 1: flag guests whose expiry date has passed. */
  async markExpiredGuests(): Promise<number> {
    const { count } = await this.prisma.user.updateMany({
      where: {
        isGuest: true,
        isExpired: false,
        expiresAt: { lt: new Date() },
      },
      data: { isExpired: true },
    });
    if (count > 0) this.logger.log(`Marked ${count} guest account(s) expired.`);
    return count;
  }

  /** Phase 2: purge guests of tournaments whose scheduled cleanup time has passed. */
  async processScheduledCleanups(): Promise<void> {
    const tournaments = await this.prisma.tournament.findMany({
      where: { guestCleanupAt: { lte: new Date(), not: null } },
      select: {
        id: true,
        participants: {
          where: { user: { isGuest: true } },
          select: { userId: true },
        },
      },
    });

    for (const t of tournaments) {
      const guestIds = t.participants.map((p) => p.userId);
      if (guestIds.length > 0) {
        // Re-check: a guest may have been converted to a real account since the
        // cleanup was scheduled, and those must never be deleted.
        const stillGuests = await this.prisma.user.findMany({
          where: { id: { in: guestIds }, isGuest: true },
          select: { id: true },
        });
        const toDelete = stillGuests.map((g) => g.id);

        if (toDelete.length > 0) {
          await this.prisma.user.deleteMany({
            where: { id: { in: toDelete } },
          });
          this.logger.log(
            `Tournament ${t.id}: purged ${toDelete.length} guest(s).`,
          );
        }
      }

      await this.prisma.tournament.update({
        where: { id: t.id },
        data: { guestCleanupAt: null },
      });
    }
  }

  /** Phase 3: guests that belong to no tournament at all. */
  async cleanOrphanedGuests(): Promise<number> {
    const deleted = await this.prisma.user.deleteMany({
      where: {
        isGuest: true,
        participatedTournaments: { none: {} },
      },
    });
    if (deleted.count > 0) {
      this.logger.log(`Deleted ${deleted.count} orphaned guest account(s).`);
    }
    return deleted.count;
  }

  /**
   * Phase 4: guests older than 7 days whose tournaments have all finished.
   * Routed through AuthService.deleteUser rather than a bulk deleteMany because
   * that method burns player names into match records first, so finished
   * brackets still read correctly after the account is gone.
   */
  async cleanStaleCompletedGuests(): Promise<number> {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const staleGuests = await this.prisma.user.findMany({
      where: {
        isGuest: true,
        createdAt: { lt: sevenDaysAgo },
        participatedTournaments: {
          every: { tournament: { status: 'COMPLETED' } },
        },
      },
      select: { id: true },
    });

    for (const guest of staleGuests) {
      await this.authService.deleteUser(guest.id);
    }
    if (staleGuests.length > 0) {
      this.logger.log(
        `Deleted ${staleGuests.length} stale guest account(s) from completed tournaments.`,
      );
    }
    return staleGuests.length;
  }
}
