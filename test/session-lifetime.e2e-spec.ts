import { sessionExpiresIn, sessionLifetimeMs } from '../src/config/security.config';

// The cookie and the signed token must agree on how long a session lasts. They
// did not before: the JWT had no expiry at all while the cookie expired after an
// hour, so the Bearer copy in localStorage outlived it forever.
describe('session lifetime', () => {
  const original = process.env.JWT_EXPIRES_IN;
  afterEach(() => {
    if (original === undefined) delete process.env.JWT_EXPIRES_IN;
    else process.env.JWT_EXPIRES_IN = original;
  });

  it('defaults to 7 days when unset', () => {
    delete process.env.JWT_EXPIRES_IN;
    expect(sessionExpiresIn()).toBe('7d');
    expect(sessionLifetimeMs()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it.each([
    ['30m', 30 * 60 * 1000],
    ['12h', 12 * 60 * 60 * 1000],
    ['1d', 24 * 60 * 60 * 1000],
    ['900s', 900 * 1000],
    ['900', 900 * 1000], // bare number = seconds, as @nestjs/jwt reads it
  ])('parses %s', (value, expected) => {
    process.env.JWT_EXPIRES_IN = value;
    expect(sessionLifetimeMs()).toBe(expected);
  });

  it('refuses an unparseable duration rather than inventing one', () => {
    // Silently falling back would give the cookie a lifetime nobody chose.
    process.env.JWT_EXPIRES_IN = 'soon';
    expect(() => sessionLifetimeMs()).toThrow(/not a valid duration/);
  });
});
