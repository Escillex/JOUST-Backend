import { GoogleAuthService, GoogleIdentity } from '../src/auth/google-auth.service';

/**
 * Google sign-in is only as safe as its account matching: emails here were
 * never verified before 2FA, so an email match alone must never hand over an
 * account that has a password. These pin that policy, the settings gate, and
 * the lock-out guard on disconnecting.
 */
const SUB = 'google-sub-123';
const ident = (over: Partial<GoogleIdentity> = {}): GoogleIdentity => ({
  sub: SUB, email: 'Paul@Example.com', emailVerified: true, name: 'Paul Scholes', hd: null, ...over,
});

function build(opts: { settings?: Record<string, string>; identity?: GoogleIdentity | Error } = {}) {
  const settings = {
    GOOGLE_SIGNIN_ENABLED: 'true',
    GOOGLE_CLIENT_ID: 'client-123.apps.googleusercontent.com',
    ...opts.settings,
  };
  const prisma: any = {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => ({ id: 'new-user', avatarUrl: null, ...data })),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, roles: ['PLAYER'], email: 'x', username: 'x', avatarUrl: null, ...data })),
    },
  };
  const settingsSvc = {
    get: jest.fn(async (k: string) => (settings as Record<string, string>)[k] ?? null),
    getBoolean: jest.fn(async (k: string) => (settings as Record<string, string>)[k] === 'true'),
  };
  const auth = { startSession: jest.fn(async (u: any) => ({ token: 't', roles: u.roles, userId: u.id })) };
  const svc = new GoogleAuthService(prisma, settingsSvc as any, auth as any);
  const verify = jest.spyOn(svc, 'verifyCredential');
  if (opts.identity instanceof Error) verify.mockRejectedValue(opts.identity);
  else verify.mockResolvedValue(opts.identity ?? ident());
  return { svc, prisma, auth, verify };
}
const res = {} as any;

describe('Google sign-in configuration', () => {
  it('offers nothing until it is enabled AND has a Client ID', async () => {
    expect(await build({ settings: { GOOGLE_SIGNIN_ENABLED: 'false' } }).svc.providers())
      .toEqual({ google: { enabled: false, clientId: null } });
    // Enabled with no Client ID would render a button that can only fail.
    expect(await build({ settings: { GOOGLE_CLIENT_ID: '' } }).svc.providers())
      .toEqual({ google: { enabled: false, clientId: null } });
    expect(await build().svc.providers())
      .toEqual({ google: { enabled: true, clientId: 'client-123.apps.googleusercontent.com' } });
  });

  it('refuses to verify anything while disabled', async () => {
    const { svc, verify } = build({ settings: { GOOGLE_SIGNIN_ENABLED: 'false' } });
    await expect(svc.signIn('tok', res)).rejects.toMatchObject({ response: { code: 'GOOGLE_SIGNIN_DISABLED' } });
    expect(verify).not.toHaveBeenCalled();
  });

  it('verifies against the Client ID from Settings — whatever this deployment configured', async () => {
    const { svc, verify } = build({ settings: { GOOGLE_CLIENT_ID: 'school-deployment.apps.googleusercontent.com' } });
    await svc.signIn('tok', res);
    expect(verify).toHaveBeenCalledWith('tok', 'school-deployment.apps.googleusercontent.com');
  });

  it('turns a bad or forged token into a 401, not a 500', async () => {
    const { svc } = build({ identity: new Error('Wrong recipient, payload audience != requiredAudience') });
    await expect(svc.signIn('forged', res)).rejects.toThrow(/could not confirm/i);
  });

  it("rejects a Google account whose email Google has not verified", async () => {
    const { svc } = build({ identity: ident({ emailVerified: false }) });
    await expect(svc.signIn('tok', res)).rejects.toThrow(/not verified/i);
  });

  it('enforces the allowed Workspace domain when one is set', async () => {
    const outsider = build({ settings: { GOOGLE_ALLOWED_DOMAIN: 'school.edu' }, identity: ident({ hd: null }) });
    await expect(outsider.svc.signIn('tok', res)).rejects.toMatchObject({ response: { code: 'GOOGLE_DOMAIN_NOT_ALLOWED' } });
    const member = build({ settings: { GOOGLE_ALLOWED_DOMAIN: 'School.edu' }, identity: ident({ hd: 'school.edu' }) });
    await expect(member.svc.signIn('tok', res)).resolves.toMatchObject({ via: 'google' });
  });
});

describe('account matching', () => {
  it('signs in the account already linked to this Google id', async () => {
    const { svc, prisma, auth } = build();
    prisma.user.findUnique.mockResolvedValue({ id: 'linked', roles: ['PLAYER'] });
    await svc.signIn('tok', res);
    expect(auth.startSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'linked' }), res);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('REFUSES an email match on an account that has a password — no takeover by email', async () => {
    const { svc, prisma, auth } = build();
    prisma.user.findFirst.mockResolvedValue({ id: 'victim', hashedPassword: '$2b$10$hash' });
    await expect(svc.signIn('tok', res)).rejects.toMatchObject({ response: { code: 'GOOGLE_EMAIL_HAS_PASSWORD' } });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(auth.startSession).not.toHaveBeenCalled();
  });

  it('links an email match that has no password, and marks the address verified', async () => {
    const { svc, prisma } = build();
    prisma.user.findFirst.mockResolvedValue({ id: 'passwordless', hashedPassword: null });
    await expect(svc.signIn('tok', res)).resolves.toMatchObject({ linked: true });
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'passwordless' },
      data: expect.objectContaining({ googleId: SUB, emailVerified: true }),
    }));
  });

  it('creates a verified, password-less account with a valid unique username', async () => {
    const { svc, prisma } = build({ identity: ident({ email: 'p.scholes+utd@gmail.com' }) });
    // "p.scholesutd" is taken (case-insensitively); the next is free.
    prisma.user.findFirst.mockImplementation(async ({ where }: any) =>
      where.username?.equals === 'p.scholesutd' ? { id: 'someone' } : null);
    await expect(svc.signIn('tok', res)).resolves.toMatchObject({ created: true });
    const data = prisma.user.create.mock.calls[0][0].data;
    expect(data.username).toBe('p.scholesutd2');
    expect(data.username).toMatch(/^[A-Za-z0-9._-]{3,20}$/);
    expect(data).toMatchObject({ email: 'p.scholes+utd@gmail.com', emailVerified: true, googleId: SUB, displayName: 'Paul Scholes' });
    expect(data.hashedPassword).toBeUndefined();
  });

  it('never matches a guest by email', async () => {
    const { svc, prisma } = build();
    await svc.signIn('tok', res);
    expect(prisma.user.findFirst.mock.calls[0][0].where).toMatchObject({ isGuest: false });
  });
});

describe('connecting and disconnecting', () => {
  it("won't connect a Google account that already belongs to someone else", async () => {
    const { svc, prisma } = build();
    prisma.user.findUnique.mockResolvedValue({ id: 'other-user' });
    await expect(svc.link('me', 'tok')).rejects.toMatchObject({ response: { code: 'GOOGLE_ALREADY_LINKED' } });
  });

  it('refuses to disconnect Google from an account with no password — that would lock it out', async () => {
    const { svc, prisma } = build();
    prisma.user.findUnique.mockResolvedValue({ hashedPassword: null });
    await expect(svc.unlink('me')).rejects.toThrow(/set a password/i);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
