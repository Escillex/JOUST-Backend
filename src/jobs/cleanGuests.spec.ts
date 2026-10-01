import { Test, TestingModule } from '@nestjs/testing';
import { CronExpression } from '@nestjs/schedule';
import { CleanGuestsJob } from './cleanGuests';
import { AuthService } from '../auth/auth.service';

/**
 * The hourly guest-retention tick.
 *
 * This suite used to exercise a `cleanOrphanedGuests` method that deleted rows
 * directly. That method is gone: deletion now routes through
 * `AuthService.purgeExpiredGuests`, which burns player names into match records
 * before removing the account and releases the handle — deleting from the job
 * would strip a person's name out of somebody else's match history. So what is
 * worth guarding here is that the job stays a thin delegate, and that the
 * schedule is registered.
 */

describe('CleanGuestsJob', () => {
  let job: CleanGuestsJob;
  let purgeExpiredGuests: jest.Mock;

  beforeEach(async () => {
    purgeExpiredGuests = jest.fn().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CleanGuestsJob,
        { provide: AuthService, useValue: { purgeExpiredGuests } },
      ],
    }).compile();

    job = module.get(CleanGuestsJob);
  });

  it('delegates the whole tick to AuthService.purgeExpiredGuests', async () => {
    await job.handleCron();
    expect(purgeExpiredGuests).toHaveBeenCalledTimes(1);
    expect(purgeExpiredGuests).toHaveBeenCalledWith();
  });

  it('does not delete users itself — names must be burned in first', () => {
    // A direct prisma dependency reappearing here is the regression this guards.
    expect(
      Object.keys(job as unknown as Record<string, unknown>),
    ).not.toContain('prisma');
  });

  it('is idempotent: a second tick is just another delegated call', async () => {
    await job.handleCron();
    await job.handleCron();
    expect(purgeExpiredGuests).toHaveBeenCalledTimes(2);
  });

  it('waits for the purge rather than firing and forgetting', async () => {
    let settled = false;
    purgeExpiredGuests.mockImplementation(
      () =>
        new Promise<void>((r) => setTimeout(() => ((settled = true), r()), 5)),
    );
    await job.handleCron();
    expect(settled).toBe(true);
  });

  it('surfaces a failure instead of reporting a clean run', async () => {
    purgeExpiredGuests.mockRejectedValue(new Error('database unavailable'));
    await expect(job.handleCron()).rejects.toThrow('database unavailable');
  });

  it('is scheduled hourly — there is exactly one guest-cleanup tick', () => {
    // Read the @Cron metadata directly rather than booting ScheduleModule.
    // The job is not registered anywhere else, so this expression is the whole
    // retention cadence.
    const options = Reflect.getMetadata(
      'SCHEDULE_CRON_OPTIONS',
      CleanGuestsJob.prototype.handleCron,
    );
    expect(options).toEqual({ cronTime: CronExpression.EVERY_HOUR });
  });
});
