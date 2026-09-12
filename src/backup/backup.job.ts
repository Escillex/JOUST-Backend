import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { BackupService } from './backup.service';
import { SettingsService } from '../settings/settings.service';

const JOB_NAME = 'scheduled-backup';

/**
 * The scheduled backup.
 *
 * Registered through `SchedulerRegistry` rather than with a static `@Cron`
 * decorator (as `CleanGuestsJob` uses) because the schedule is a setting an
 * admin edits in the browser — a decorator would freeze it at boot and require
 * a restart to change, which is exactly what this whole feature exists to avoid.
 */
@Injectable()
export class BackupJob implements OnModuleInit {
  private readonly logger = new Logger(BackupJob.name);

  constructor(
    private readonly backups: BackupService,
    private readonly settings: SettingsService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  async onModuleInit() {
    await this.reschedule();
  }

  /** Re-read the schedule and apply it. Called at boot and whenever the
   *  settings change, so a new cron takes effect without a restart. */
  async reschedule(): Promise<{ enabled: boolean; cron: string }> {
    const enabled = await this.settings.getBoolean('BACKUP_ENABLED');
    const cron = (await this.settings.get('BACKUP_CRON')) || '0 3 * * *';

    if (this.scheduler.doesExist('cron', JOB_NAME)) {
      this.scheduler.deleteCronJob(JOB_NAME);
    }
    if (!enabled) {
      this.logger.log('Scheduled backups are off.');
      return { enabled, cron };
    }

    try {
      const job = new CronJob(cron, () => void this.run());
      this.scheduler.addCronJob(JOB_NAME, job as never);
      job.start();
      this.logger.log(`Scheduled backups on "${cron}".`);
    } catch {
      // A malformed expression must not take the process down at boot; the
      // schedule simply does not run, and says so.
      this.logger.error(`"${cron}" is not a valid cron expression — no backup scheduled.`);
    }
    return { enabled, cron };
  }

  private async run() {
    try {
      const backup = await this.backups.create({ trigger: 'scheduled' });
      this.logger.log(`Scheduled backup written: ${backup.name}`);
    } catch (err) {
      // Loud, but never fatal: a failed backup is not a reason to take the
      // application down, and the next run may well succeed.
      this.logger.error(`Scheduled backup failed: ${(err as Error).message}`);
    }
  }
}
