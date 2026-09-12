import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { SettingsService } from './settings.service';
import { TestEmailDto, UpdateSettingDto } from './dto/settings.dto';
import { MailService } from '../mail/mail.service';
import { BackupJob } from '../backup/backup.job';
import { testEmail as testEmailTemplate } from '../mail/templates';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../guards/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../guards/jwt-auth.guard';

/** Admin-only runtime configuration. Secrets are write-only: `GET` reports
 *  whether one is configured, never what it is. */
@Controller('admin/settings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly mail: MailService,
    private readonly backupJob: BackupJob,
  ) {}

  @Get()
  list() {
    return this.settings.listForAdmin();
  }

  @Patch()
  async update(
    @Body() dto: UpdateSettingDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = req.user.id || (req.user as any).sub;
    await this.settings.set(dto.name, dto.value, userId);
    // The backup schedule is a setting, so changing it has to take effect now.
    // Waiting for a restart would make the control a lie.
    if (dto.name === 'BACKUP_ENABLED' || dto.name === 'BACKUP_CRON') {
      await this.backupJob.reschedule();
    }
    return { message: 'Setting updated' };
  }

  /**
   * Send a real message with the settings as they currently stand.
   *
   * The point is to discover mail is broken HERE, while an admin is looking at
   * the screen — not later, when somebody cannot sign in because their code
   * never arrived. The transport's own error is passed back verbatim rather than
   * flattened to "failed": "Invalid login: 535 authentication failed" tells you
   * the SMTP key is wrong; "failed" tells you nothing.
   */
  @Post('test-email')
  async testEmail(@Body() dto: TestEmailDto) {
    // Connect first. A wrong SMTP key fails here with the relay's own words,
    // which is a different problem from a message the relay accepted and then
    // refused to deliver — and the admin needs to know which one they have.
    const check = await this.mail.verifyTransport();
    if (!check.delivered) {
      return {
        delivered: false,
        transport: check.transport,
        ...(check.error ? { error: check.error } : {}),
        message: 'Could not connect to the mail server — nothing was sent.',
      };
    }

    const result = await this.mail.send({
      to: dto.to,
      ...testEmailTemplate(),
    });
    return {
      delivered: result.delivered,
      transport: result.transport,
      ...(result.error ? { error: result.error } : {}),
      message: result.delivered
        ? result.transport === 'console'
          ? 'Written to the server log — transport is "console", so nothing left the machine.'
          : `Sent to ${dto.to}. Check the inbox, and the spam folder.`
        : 'Could not send.',
    };
  }
}
