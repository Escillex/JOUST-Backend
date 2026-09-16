import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard, isSessionToken } from '../src/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../src/guards/optional-jwt-auth.guard';

// Login is no longer one step: a password check can hand back a token that only
// permits finishing 2FA or replacing a forced password. The whole security of
// that design rests on those tokens being useless anywhere else, so it is pinned
// here rather than left to reviewer memory.
describe('token purpose', () => {
  const secret = 'test-secret-that-is-definitely-long-enough-32';
  const jwt = new JwtService({ secret });

  const contextWith = (token: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ cookies: { token }, headers: {} }) as any,
      }),
    }) as any;

  beforeAll(() => {
    process.env.JWT_SECRET = secret;
  });

  const sign = (purpose?: string) =>
    jwt.sign({ id: 'u1', email: null, username: 'u', roles: [], ...(purpose ? { purpose } : {}) });

  describe('isSessionToken', () => {
    it('treats a token with no purpose as a session', () => {
      // Tokens issued before the claim existed must keep working, or deploying
      // this signs everyone out.
      expect(isSessionToken({ id: 'u1', email: null, username: null, roles: [] })).toBe(true);
    });

    it('accepts session and rejects the intermediate purposes', () => {
      expect(isSessionToken({ id: 'u1', email: null, username: null, roles: [], purpose: 'session' })).toBe(true);
      expect(isSessionToken({ id: 'u1', email: null, username: null, roles: [], purpose: '2fa' })).toBe(false);
      expect(isSessionToken({ id: 'u1', email: null, username: null, roles: [], purpose: 'password_change' })).toBe(false);
    });
  });

  describe('JwtAuthGuard', () => {
    // No revocation stamp on this account, so the guard's check passes through.
    const prisma: any = { user: { findUnique: jest.fn(async () => ({ sessionsValidFrom: null })) } };
    const guard = new JwtAuthGuard(jwt, prisma);

    it('admits a session token', async () => {
      await expect(guard.canActivate(contextWith(sign('session')))).resolves.toBe(true);
    });

    it('admits a legacy token with no purpose', async () => {
      await expect(guard.canActivate(contextWith(sign()))).resolves.toBe(true);
    });

    it('refuses a 2FA challenge token', async () => {
      await expect(guard.canActivate(contextWith(sign('2fa')))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('refuses a forced-password-change token', async () => {
      await expect(
        guard.canActivate(contextWith(sign('password_change'))),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('OptionalJwtAuthGuard', () => {
    const guard = new OptionalJwtAuthGuard(jwt);

    // This one is easy to overlook: it never throws, so a missed check here does
    // not fail loudly — it silently treats a half-authenticated caller as the
    // user, including on the admin-gated combined leaderboard.
    it('leaves the request anonymous for an intermediate token', async () => {
      const request: any = { cookies: { token: sign('2fa') }, headers: {} };
      const ctx: any = { switchToHttp: () => ({ getRequest: () => request }) };
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(request.user).toBeUndefined();
    });

    it('attaches the user for a real session token', async () => {
      const request: any = { cookies: { token: sign('session') }, headers: {} };
      const ctx: any = { switchToHttp: () => ({ getRequest: () => request }) };
      await guard.canActivate(ctx);
      expect(request.user?.id).toBe('u1');
    });
  });
});

/**
 * Sign out everywhere (2026-09-16). Sessions last seven days, and nothing could
 * end one early — a stolen token outlived the password change meant to stop it.
 */
describe('JwtAuthGuard revocation', () => {
  const secret = 'test-secret-that-is-definitely-long-enough-32';
  process.env.JWT_SECRET = secret;
  const jwt = new JwtService({ secret });

  const ctx = (token: string) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ cookies: { token }, headers: {} }) }) }) as any;
  const tokenIssuedAt = async (secondsAgo: number) =>
    jwt.signAsync({ id: 'u1', email: null, username: null, roles: [], purpose: 'session', iat: Math.floor(Date.now() / 1000) - secondsAgo }, { secret });

  const guardFor = (validFrom: Date | null) =>
    new JwtAuthGuard(jwt, { user: { findUnique: async () => ({ sessionsValidFrom: validFrom }) } } as any);

  beforeEach(() => JwtAuthGuard.forget('u1'));

  it('refuses a token issued before the account signed out everywhere', async () => {
    const guard = guardFor(new Date());
    await expect(guard.canActivate(ctx(await tokenIssuedAt(60)))).rejects.toThrow('Signed out');
  });

  it('admits the replacement session issued in the stamped second (a password change)', async () => {
    const guard = guardFor(new Date(Math.floor(Date.now() / 1000) * 1000));
    await expect(guard.canActivate(ctx(await tokenIssuedAt(0)))).resolves.toBe(true);
  });

  it('refuses even this second’s tokens when the stamp is the next second (sign out everywhere)', async () => {
    const guard = guardFor(new Date((Math.floor(Date.now() / 1000) + 1) * 1000));
    await expect(guard.canActivate(ctx(await tokenIssuedAt(0)))).rejects.toThrow('Signed out');
  });

  it('admits everything when nothing has been revoked', async () => {
    const guard = guardFor(null);
    await expect(guard.canActivate(ctx(await tokenIssuedAt(60 * 60 * 24)))).resolves.toBe(true);
  });
});
