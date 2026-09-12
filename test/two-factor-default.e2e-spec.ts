import * as bcrypt from 'bcrypt';
import { TwoFactorService } from '../src/auth/two-factor.service';
import { AuthService } from '../src/auth/auth.service';

/**
 * 2FA defaults OFF (2026-09-13): a deployment with no working mail must still
 * be able to register and sign people in. Turning it on restores the emailed
 * code and the address check — pinned here too, so "off by default" never
 * quietly becomes "off always".
 */
const tf = (stored: string | null) =>
  new TwoFactorService({} as any, {} as any, { get: jest.fn(async () => stored) } as any);

describe('enforcement default', () => {
  afterEach(() => { TwoFactorService.enforcementOverride = null; });

  it('is off when nothing is configured', async () => {
    expect(await tf(null).enforcementMode()).toBe('off');
    expect(await tf(null).emailRequired()).toBe(false);
  });

  it('honours an explicit setting, case-insensitively', async () => {
    expect(await tf('all').enforcementMode()).toBe('all');
    expect(await tf('Staff').enforcementMode()).toBe('staff');
    expect(await tf(' OFF ').enforcementMode()).toBe('off');
  });

  it('fails closed on a garbled value rather than silently disabling', async () => {
    expect(await tf('yes please').enforcementMode()).toBe('all');
  });
});

function authWith(mode: string, user?: Record<string, unknown>) {
  const prisma: any = {
    user: {
      findFirst: jest.fn(async () => user ?? null),
      create: jest.fn(async ({ data }: any) => ({ id: 'new', ...data })),
      findUnique: jest.fn(async () => null),
    },
  };
  const twoFactor: any = {
    emailRequired: jest.fn(async () => mode !== 'off'),
    isRequiredFor: jest.fn(async () => mode === 'all'),
    isTrustedDevice: jest.fn(async () => false),
    issueCode: jest.fn(async () => ({ sent: true })),
  };
  const jwt: any = { signAsync: jest.fn(async () => 'tok') };
  const svc = new AuthService(prisma, jwt, twoFactor);
  return { svc, twoFactor, prisma };
}
const res: any = { cookie: jest.fn() };

describe('registration and sign-in follow the mode', () => {
  const signup = { identifier: 'newplayer', email: 'New@Example.com', password: 'long-enough-1' } as any;

  it('off: registration needs no emailed code', async () => {
    const { svc, twoFactor } = authWith('off');
    const out = await svc.SignUp(signup);
    expect(out).toMatchObject({ verificationRequired: false });
    expect(out).not.toHaveProperty('challenge');
    expect(twoFactor.issueCode).not.toHaveBeenCalled();
  });

  it('all: registration still verifies the address', async () => {
    const { svc, twoFactor } = authWith('all');
    const out = await svc.SignUp(signup);
    expect(out).toMatchObject({ verificationRequired: true });
    expect(twoFactor.issueCode).toHaveBeenCalledWith(expect.anything(), 'verify');
  });

  const unverified = async () => ({
    id: 'u1', username: 'newplayer', email: 'new@example.com', roles: ['PLAYER'], isGuest: false,
    emailVerified: false, avatarUrl: null, hashedPassword: await bcrypt.hash('long-enough-1', 4),
  });

  it('off: an unverified account signs straight in', async () => {
    const { svc, twoFactor } = authWith('off', await unverified());
    const out: any = await svc.SignIn({ identifier: 'newplayer', password: 'long-enough-1' } as any, res);
    expect(out.token).toBe('tok');
    expect(twoFactor.issueCode).not.toHaveBeenCalled();
  });

  it('all: the same unverified account must prove its address first', async () => {
    const { svc } = authWith('all', await unverified());
    const out: any = await svc.SignIn({ identifier: 'newplayer', password: 'long-enough-1' } as any, res);
    expect(out).toMatchObject({ verificationRequired: true });
    expect(out.token).toBeUndefined();
  });
});
