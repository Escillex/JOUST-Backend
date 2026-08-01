/** Startup validation for the secrets and origins the app cannot safely run
 *  without. Plan items 7.6 and 7.7.
 *
 *  The failure mode this prevents is silent: with `JWT_SECRET` left at the
 *  placeholder the app starts, signs, and verifies perfectly happily — using a
 *  key that is committed to the repository and therefore known to anyone who
 *  can read it. Every token in that deployment is forgeable, including an admin
 *  one. Nothing about that is visible in the logs or the UI, which is exactly
 *  why it survived this long. Refusing to boot is the only version of this that
 *  cannot be ignored.
 */

/** Values that must never be accepted as a real secret. */
const PLACEHOLDER_SECRETS = new Set([
  'your-secret-key-here',
  'secret',
  'changeme',
  'change-me',
  'jwt-secret',
  'test',
]);

const MIN_SECRET_LENGTH = 32;

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Returns the JWT signing secret, or throws if it is missing, a known
 * placeholder, or too short to be meaningful.
 *
 * Throwing beats defaulting: a default here would reintroduce the exact bug
 * this exists to catch.
 */
export function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;

  if (!secret || secret.trim() === '') {
    throw new Error(
      'JWT_SECRET is not set. The application cannot sign or verify sessions ' +
        'without it. Generate one with:  openssl rand -base64 48',
    );
  }

  if (PLACEHOLDER_SECRETS.has(secret.trim().toLowerCase())) {
    throw new Error(
      `JWT_SECRET is still the placeholder value "${secret}". This value is in ` +
        'the repository, so every session token signed with it can be forged by ' +
        'anyone who can read the source — including an admin token. Generate a ' +
        'real one with:  openssl rand -base64 48',
    );
  }

  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET is only ${secret.length} characters. Use at least ` +
        `${MIN_SECRET_LENGTH}:  openssl rand -base64 48`,
    );
  }

  return secret;
}

/**
 * Origins permitted to make credentialed browser requests.
 *
 * In development this returns `null`, meaning "reflect any origin" — LAN IPs and
 * changing dev ports make an allowlist impractical there, and a development
 * machine is not the threat model. In production an explicit list is required:
 * reflecting arbitrary origins while `credentials: true` is set lets any site a
 * signed-in user visits read authenticated responses.
 */
export function corsAllowedOrigins(): string[] | null {
  const configured = process.env.ALLOWED_ORIGINS;
  if (configured && configured.trim() !== '') {
    return configured
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  }

  if (isProduction()) {
    throw new Error(
      'ALLOWED_ORIGINS must be set in production. Reflecting any origin while ' +
        'credentials are allowed lets any website a signed-in user visits read ' +
        'their authenticated responses. Example: ' +
        'ALLOWED_ORIGINS=https://joust.escillex.com',
    );
  }

  return null;
}

/**
 * Cookie options for the session token.
 *
 * `secure` is env-driven rather than hardcoded: forcing it on in development
 * would silently break sign-in over plain http, and leaving it off in
 * production would let the session cookie travel unencrypted.
 */
export function sessionCookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    // Blocks the cross-site socket/XHR hijack described in
    // realtime.gateway.ts: a cross-site handshake never carries this cookie.
    sameSite: 'lax' as const,
    secure: isProduction(),
    maxAge: maxAgeMs,
    path: '/',
  };
}
