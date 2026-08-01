import {
  requireJwtSecret,
  corsAllowedOrigins,
  sessionCookieOptions,
} from './security.config';

/** Plan items 7.6 and 7.7. These guard a failure that is invisible at runtime:
 *  with a placeholder secret everything works, and every token is forgeable. */
describe('security config', () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  describe('requireJwtSecret', () => {
    it('rejects the placeholder that shipped in the repository', () => {
      process.env.JWT_SECRET = 'your-secret-key-here';
      expect(() => requireJwtSecret()).toThrow(/placeholder/i);
    });

    it('rejects a missing or empty secret', () => {
      delete process.env.JWT_SECRET;
      expect(() => requireJwtSecret()).toThrow(/not set/i);
      process.env.JWT_SECRET = '   ';
      expect(() => requireJwtSecret()).toThrow(/not set/i);
    });

    it('rejects a secret too short to be worth having', () => {
      process.env.JWT_SECRET = 'short';
      expect(() => requireJwtSecret()).toThrow(/at least/i);
    });

    it('accepts a real secret and returns it unchanged', () => {
      const real = 'K3f9wQ2mZp8vN1xR7tY4uB6cA0sD5gH2jL9kM3nP1qW8eR7t';
      process.env.JWT_SECRET = real;
      expect(requireJwtSecret()).toBe(real);
    });
  });

  describe('corsAllowedOrigins', () => {
    it('reflects any origin in development', () => {
      delete process.env.ALLOWED_ORIGINS;
      process.env.NODE_ENV = 'development';
      expect(corsAllowedOrigins()).toBeNull();
    });

    it('refuses to run open in production', () => {
      delete process.env.ALLOWED_ORIGINS;
      process.env.NODE_ENV = 'production';
      expect(() => corsAllowedOrigins()).toThrow(/ALLOWED_ORIGINS/);
    });

    it('parses a configured list and trims whitespace', () => {
      process.env.ALLOWED_ORIGINS =
        ' https://joust.escillex.com , http://localhost:3000 ';
      expect(corsAllowedOrigins()).toEqual([
        'https://joust.escillex.com',
        'http://localhost:3000',
      ]);
    });
  });

  describe('sessionCookieOptions', () => {
    it('leaves secure off in development so http sign-in still works', () => {
      process.env.NODE_ENV = 'development';
      expect(sessionCookieOptions(1000).secure).toBe(false);
    });

    it('sets secure in production so the session cookie is not sent in clear', () => {
      process.env.NODE_ENV = 'production';
      expect(sessionCookieOptions(1000).secure).toBe(true);
    });

    it('always keeps httpOnly and sameSite=lax', () => {
      // sameSite=lax is what stops a cross-site socket handshake from carrying
      // this cookie — see the private-room gate in realtime.gateway.ts.
      const opts = sessionCookieOptions(1000);
      expect(opts.httpOnly).toBe(true);
      expect(opts.sameSite).toBe('lax');
    });
  });
});
