import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Encryption for secret settings — currently the SMTP key, which an admin types
 * into the browser and which must not sit in the database as plaintext.
 *
 * AES-256-GCM, so the ciphertext is authenticated: a tampered value fails to
 * decrypt rather than quietly returning rubbish that would then be used as a
 * password. Format is `v1:<iv>:<authTag>:<ciphertext>`, all base64 — versioned
 * so the scheme can change later without guessing at what old rows contain.
 */
const VERSION = 'v1';
const IV_BYTES = 12; // GCM standard

/** The key, as 32 bytes. Accepts 64 hex chars or base64; anything else is a
 *  configuration error worth failing loudly on, since the alternative is
 *  secrets that cannot be read back after a restart. */
export function requireSettingsKey(): Buffer {
  const raw = process.env.SETTINGS_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new Error(
      'SETTINGS_ENCRYPTION_KEY is not set. It is required to store secret settings ' +
        '(e.g. the SMTP key). Generate one with: openssl rand -hex 32',
    );
  }
  const key = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `SETTINGS_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}). ` +
        'Generate one with: openssl rand -hex 32',
    );
  }
  return key;
}

export function encryptSetting(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', requireSettingsKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    enc.toString('base64'),
  ].join(':');
}

export function decryptSetting(stored: string): string {
  const [version, iv, tag, payload] = stored.split(':');
  if (version !== VERSION || !iv || !tag || !payload) {
    throw new Error('Stored secret is not in the expected format');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    requireSettingsKey(),
    Buffer.from(iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(payload, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
