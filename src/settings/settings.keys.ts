/**
 * Every setting the app reads, in one place, with the env var it falls back to.
 *
 * Resolution is DB -> env -> default. The env fallback is what lets a freshly
 * started container send mail before anyone has logged in to configure it; the
 * DB value is what an admin can change without a redeploy.
 */
export interface SettingSpec {
  /** Storage key, also the API key. */
  key: string;
  /** Env var consulted when the DB has no row. */
  env?: string;
  default?: string;
  /** Held as ciphertext and never returned by the API. */
  secret?: boolean;
}

export const SETTINGS = {
  MAIL_TRANSPORT: {
    key: 'mail.transport',
    env: 'MAIL_TRANSPORT',
    default: 'console',
  },
  MAIL_HOST: {
    key: 'mail.host',
    env: 'MAIL_HOST',
    default: 'smtp-relay.brevo.com',
  },
  MAIL_PORT: { key: 'mail.port', env: 'MAIL_PORT', default: '587' },
  MAIL_USER: { key: 'mail.user', env: 'MAIL_USER' },
  MAIL_PASS: { key: 'mail.pass', env: 'MAIL_PASS', secret: true },
  MAIL_FROM: {
    key: 'mail.from',
    env: 'MAIL_FROM',
    default: 'JOUST <noreply@example.com>',
  },
  MAIL_REPLY_TO: { key: 'mail.replyTo', env: 'MAIL_REPLY_TO' },
  TWO_FACTOR_ENFORCEMENT: {
    key: 'security.twoFactorEnforcement',
    env: 'TWO_FACTOR_ENFORCEMENT',
    default: 'all',
  },
  GOOGLE_SIGNIN_ENABLED: {
    key: 'security.googleSignIn',
    env: 'GOOGLE_SIGNIN_ENABLED',
    default: 'false',
  },
  SETUP_COMPLETED_AT: { key: 'setup.completedAt' },
} as const satisfies Record<string, SettingSpec>;

export type SettingName = keyof typeof SETTINGS;

/** Keys an admin may write through the API. `setup.completedAt` is excluded
 *  deliberately — it is set by finishing the wizard, not by typing a date. */
export const EDITABLE_SETTINGS: SettingName[] = [
  'MAIL_TRANSPORT',
  'MAIL_HOST',
  'MAIL_PORT',
  'MAIL_USER',
  'MAIL_PASS',
  'MAIL_FROM',
  'MAIL_REPLY_TO',
  'TWO_FACTOR_ENFORCEMENT',
  'GOOGLE_SIGNIN_ENABLED',
];
