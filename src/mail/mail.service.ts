import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { ConsoleTransport } from './console.transport';
import { SmtpTransport } from './smtp.transport';
import { MailMessage, MailResult, MailTransport } from './mail.types';

/**
 * Outbound email.
 *
 * Deliberately unlike `NotificationService`, whose writes are best-effort and
 * swallowed: a notification that vanishes is a missed nudge, whereas a 2FA code
 * that vanishes is a locked-out user. So delivery is *reported* — the caller
 * gets `{ delivered: false, error }` and can tell the user the truth — but a
 * failure still never throws into the request.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly settings: SettingsService) {}

  /** Built per send so a settings change takes effect without a restart. */
  private async transport(): Promise<MailTransport> {
    const mode = (await this.settings.get('MAIL_TRANSPORT')) ?? 'console';
    if (mode !== 'smtp') return new ConsoleTransport();

    const [host, port, user, pass] = await Promise.all([
      this.settings.get('MAIL_HOST'),
      this.settings.get('MAIL_PORT'),
      this.settings.get('MAIL_USER'),
      this.settings.get('MAIL_PASS'),
    ]);
    if (!host || !user || !pass) {
      throw new Error(
        'MAIL_TRANSPORT is "smtp" but host, user or password is not configured (Admin → Settings).',
      );
    }
    return new SmtpTransport({
      host,
      port: Number(port) || 587,
      user,
      pass,
    });
  }

  async send(message: MailMessage): Promise<MailResult> {
    const from =
      (await this.settings.get('MAIL_FROM')) ?? 'JOUST <noreply@example.com>';
    const replyTo = (await this.settings.get('MAIL_REPLY_TO')) ?? undefined;

    let transport: MailTransport;
    try {
      transport = await this.transport();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(`Mail not configured: ${error}`);
      return { delivered: false, transport: 'none', error };
    }

    try {
      await transport.send(message, from, replyTo);
      return { delivered: true, transport: transport.name };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // Loud: this is the failure that locks people out of their accounts.
      this.logger.error(
        `Failed to send "${message.subject}" to ${message.to} via ${transport.name}: ${error}`,
      );
      return { delivered: false, transport: transport.name, error };
    }
  }
}
