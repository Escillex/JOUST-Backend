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
  /** OFF by default (2026-09-13): email is the second factor, and a fresh
   *  deployment has no working mail until an admin configures SMTP. Defaulting
   *  to 'all' meant a new install — or prod on first deploy — could not sign
   *  anyone in, because every code went to a server log. Switch it on in
   *  Admin → Settings once "Send test email" delivers. */
  TWO_FACTOR_ENFORCEMENT: {
    key: 'security.twoFactorEnforcement',
    env: 'TWO_FACTOR_ENFORCEMENT',
    default: 'off',
  },
  GOOGLE_SIGNIN_ENABLED: {
    key: 'security.googleSignIn',
    env: 'GOOGLE_SIGNIN_ENABLED',
    default: 'false',
  },
  /** The OAuth Client ID from the DEPLOYER's own Google Cloud project — never a
   *  maintainer's — so each deployment's Google consent screen names that
   *  deployment. Public by design (it ships to every browser); the ID-token
   *  flow needs no client secret, so nothing sensitive is stored for Google. */
  GOOGLE_CLIENT_ID: { key: 'security.googleClientId', env: 'GOOGLE_CLIENT_ID' },
  /** Optional: only accept Google accounts from this Workspace domain (e.g. a
   *  school's), checked against the token's `hd` claim. Empty = any account. */
  GOOGLE_ALLOWED_DOMAIN: {
    key: 'security.googleAllowedDomain',
    env: 'GOOGLE_ALLOWED_DOMAIN',
  },
  /** Bulk guest creation is off unless explicitly allowed: it mints real user
   *  rows in a loop, and an organizer who fat-fingers a quantity can flood a
   *  tournament (and the guest-cleanup crons) in one click. Opt-in, not
   *  opt-out. */
  DEV_BULK_GUESTS: {
    key: 'dev.bulkGuests',
    env: 'DEV_BULK_GUESTS',
    default: 'false',
  },
  /** Backups. The directory is deliberately project-relative by default so the
   *  whole feature travels to another host unchanged; see BackupService. */
  BACKUP_ENABLED: {
    key: 'backup.enabled',
    env: 'BACKUP_ENABLED',
    default: 'false',
  },
  BACKUP_CRON: { key: 'backup.cron', env: 'BACKUP_CRON', default: '0 3 * * *' },
  BACKUP_RETENTION: {
    key: 'backup.retention',
    env: 'BACKUP_RETENTION',
    default: '14',
  },
  BACKUP_DIR: { key: 'backup.dir', env: 'BACKUP_DIR' },
  /** A restore overwrites the entire database, so it is off unless somebody
   *  deliberately switched it on — the same treatment as DEV_BULK_GUESTS. */
  BACKUP_ALLOW_RESTORE: {
    key: 'backup.allowRestore',
    env: 'BACKUP_ALLOW_RESTORE',
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
  'GOOGLE_CLIENT_ID',
  'GOOGLE_ALLOWED_DOMAIN',
  'DEV_BULK_GUESTS',
  'BACKUP_ENABLED',
  'BACKUP_CRON',
  'BACKUP_RETENTION',
  'BACKUP_DIR',
  'BACKUP_ALLOW_RESTORE',
];
