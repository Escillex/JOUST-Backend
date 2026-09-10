export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Delivery is reported, never thrown. A 2FA code that fails to send must be
 *  visible to the caller so it can tell the user "we could not email you" —
 *  but it must not take down the request with an exception either. */
export interface MailResult {
  delivered: boolean;
  transport: string;
  error?: string;
}

export interface MailTransport {
  readonly name: string;
  send(message: MailMessage, from: string, replyTo?: string): Promise<void>;
}
