import { createTransport, type Transporter } from 'nodemailer';
import { MailMessage, MailTransport } from './mail.types';

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

/**
 * SMTP delivery — Brevo by default, but nothing here is Brevo-specific: the
 * same code sends through Mailjet, Gmail or any other relay by changing the
 * settings values. That is why this went over SMTP rather than a provider's
 * HTTP API, which would have baked one vendor's request shape into the app.
 *
 * The object is short-lived by design: `MailService` builds a fresh transport
 * per send from the current settings, so an admin editing the SMTP host takes
 * effect on the next email rather than on the next restart.
 */
export class SmtpTransport implements MailTransport {
  readonly name = 'smtp';
  private client?: Transporter;

  constructor(private readonly config: SmtpConfig) {}

  private getClient(): Transporter {
    if (!this.client) {
      this.client = createTransport({
        host: this.config.host,
        port: this.config.port,
        // 465 is implicit TLS; 587 upgrades with STARTTLS.
        secure: this.config.port === 465,
        auth: { user: this.config.user, pass: this.config.pass },
      });
    }
    return this.client;
  }

  async send(
    message: MailMessage,
    from: string,
    replyTo?: string,
  ): Promise<void> {
    await this.getClient().sendMail({
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      ...(replyTo ? { replyTo } : {}),
    });
  }

  /**
   * Open a connection and authenticate without sending anything.
   *
   * This is what makes "Send test email" honest about *where* it failed: a bad
   * host or a wrong SMTP key fails here, before a message is composed, and
   * nodemailer's own error text ("535 authentication failed") is far more use
   * than a generic send failure.
   */
  async verify(): Promise<void> {
    await this.getClient().verify();
  }
}
