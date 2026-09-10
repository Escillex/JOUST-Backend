import { Logger } from '@nestjs/common';
import { MailMessage, MailTransport } from './mail.types';

/**
 * Writes the message to the log instead of sending it.
 *
 * This is not a stub — it is how the dev and trinity instances run. Those use
 * `@example.com` addresses with no real inbox, so logging the body is the only
 * way the verification and 2FA flows can be exercised there at all. Read the
 * code out of `docker logs trinity-server-1`.
 */
export class ConsoleTransport implements MailTransport {
  readonly name = 'console';
  private readonly logger = new Logger('Mail');

  async send(
    message: MailMessage,
    from: string,
    replyTo?: string,
  ): Promise<void> {
    this.logger.log(
      [
        '─── EMAIL (console transport — not sent) ───',
        `from:    ${from}`,
        `to:      ${message.to}`,
        replyTo ? `replyTo: ${replyTo}` : null,
        `subject: ${message.subject}`,
        '',
        message.text,
        '────────────────────────────────────────────',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
}
