import { MailMessage, MailTransport } from './mail.types';

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

/** The shape of nodemailer this file actually uses. Declared locally so the
 *  project compiles whether or not the package is installed. */
interface NodemailerLike {
  createTransport(options: unknown): {
    sendMail(message: Record<string, unknown>): Promise<unknown>;
  };
}

/**
 * SMTP delivery — Brevo by default, but nothing here is Brevo-specific: the
 * same code sends through Mailjet, Gmail or any other relay by changing the
 * settings values. That is why this went over SMTP rather than a provider's
 * HTTP API, which would have baked one vendor's request shape into the app.
 *
 * nodemailer is loaded through a non-literal specifier on purpose: it keeps the
 * build working before the dependency is installed, and turns a missing package
 * into a clear message instead of a module-resolution crash at boot.
 */
export class SmtpTransport implements MailTransport {
  readonly name = 'smtp';
  private client?: ReturnType<NodemailerLike['createTransport']>;

  constructor(private readonly config: SmtpConfig) {}

  private async getClient() {
    if (this.client) return this.client;
    const moduleName = 'nodemailer';
    let nodemailer: NodemailerLike;
    try {
      nodemailer = (await import(moduleName)) as unknown as NodemailerLike;
    } catch {
      throw new Error(
        'MAIL_TRANSPORT is "smtp" but nodemailer is not installed. Run: npm i nodemailer',
      );
    }
    this.client = nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      // 465 is implicit TLS; 587 upgrades with STARTTLS.
      secure: this.config.port === 465,
      auth: { user: this.config.user, pass: this.config.pass },
    });
    return this.client;
  }

  async send(
    message: MailMessage,
    from: string,
    replyTo?: string,
  ): Promise<void> {
    const client = await this.getClient();
    await client.sendMail({
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      ...(replyTo ? { replyTo } : {}),
    });
  }
}
