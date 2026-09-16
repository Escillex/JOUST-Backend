import * as bcrypt from 'bcrypt';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AccountService, maskEmail } from '../src/auth/account.service';
import { AuthService } from '../src/auth/auth.service';
import { TwoFactorService } from '../src/auth/two-factor.service';
import { MailService } from '../src/mail/mail.service';
import { UpdateMeDto } from '../src/auth/dto/auth.dto';

/**
 * Account settings (2026-09-16). A session alone used to be enough to change
 * the password or the email — so a phone left unlocked at a venue gave the
 * account away. Every sensitive change now needs proof: the emailed code when
 * the site can send mail, else the current password.
 */

const PASSWORD = 'correct-horse';

async function build(opts: { mail?: boolean; user?: Record<string, unknown> } = {}) {
  const hashed = await bcrypt.hash(PASSWORD, 4);
  const user = {
    id: 'u1',
    username: 'caleb-ruiz',
    displayName: 'Caleb Ruiz',
    email: 'caleb@club.org',
    hashedPassword: hashed,
    isGuest: false,
    roles: ['PLAYER'],
    emailVerified: true,
    googleId: null,
    twoFactorRecoveryCodes: ['a', 'b'],
    ...opts.user,
  };
  const prisma: any = {
    user: {
      findUnique: jest.fn(async () => user),
      findFirst: jest.fn(async () => null),
      update: jest.fn(async ({ data }: any) => ({ ...user, ...data })),
      count: jest.fn(async () => 1),
    },
    tournamentParticipant: { findMany: jest.fn(async () => []) },
  };
  const auth = {
    codeFailureMessage: (r: string) => `code ${r}`,
    hashPassword: async (p: string) => `hashed:${p}`,
    deleteUser: jest.fn(async () => ({})),
  };
  const twoFactor = {
    checkCode: jest.fn(async (_id: string, code: string) => (code === '123456' ? { ok: true } : { ok: false, reason: 'invalid' })),
    issueCode: jest.fn(async (_user: unknown, _kind: string) => ({ sent: true })),
    revokeDevices: jest.fn(async () => 2),
    forgetDevice: jest.fn(async () => false),
    listDevices: jest.fn(async () => []),
    enforcementMode: jest.fn(async () => 'off'),
    isRequiredFor: jest.fn(async () => false),
    generateRecoveryCodes: jest.fn(async () => ['NEW-1']),
  };
  const mail = { isConfigured: jest.fn(async () => !!opts.mail) };
  const audit = { record: jest.fn(async () => undefined) };
  // A credential of 'good' belongs to this account; anything else does not.
  const google = { identify: jest.fn(async (c: string) => ({ sub: c === 'good' ? user.googleId : 'someone-else' })) };
  const svc = new AccountService(prisma, auth as any, twoFactor as any, mail as any, audit as any, google as any);
  return { svc, prisma, auth, twoFactor, mail, audit, google, user };
}

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: any) => e.getResponse?.().code ?? e.message,
  );

describe('account settings — which proof', () => {
  it('asks for the emailed code when the site can send mail', async () => {
    const { svc, user } = await build({ mail: true });
    expect(await svc.proofMethod(user)).toBe('code');
  });

  it('falls back to the current password when mail is not set up', async () => {
    const { svc, user } = await build({ mail: false });
    expect(await svc.proofMethod(user)).toBe('password');
  });

  it('has nothing to ask for from a Google-only account on a site without mail, and refuses', async () => {
    const { svc } = await build({ mail: false, user: { hashedPassword: null } });
    expect(await codeOf(svc.changePassword('u1', { newPassword: 'another-one' }))).toBe('NO_PROOF_AVAILABLE');
  });

  it('will not email a code on a site that confirms by password — no inbox spam route', async () => {
    const { svc, twoFactor } = await build({ mail: false });
    expect(await codeOf(svc.sendCode('u1'))).toBe('CODE_NOT_USED');
    expect(twoFactor.issueCode).not.toHaveBeenCalled();
  });

  it('emails a change code, to the address on file, when mail is set up', async () => {
    const { svc, twoFactor } = await build({ mail: true });
    const res = await svc.sendCode('u1');
    expect(twoFactor.issueCode.mock.calls[0][1]).toBe('change');
    expect(res.to).toBe(maskEmail('caleb@club.org'));
  });
});

describe('account settings — Google as proof', () => {
  it('is what a Google-only account on a mail-less site is asked for', async () => {
    const { svc, user } = await build({ mail: false, user: { hashedPassword: null, googleId: 'g-1' } });
    expect(await svc.proofMethod(user)).toBe('google');
    expect(await codeOf(svc.changePassword('u1', { newPassword: 'first-one-1' }))).toBe('GOOGLE_REQUIRED');
  });

  it('lets that account set a password — a Google account becoming an ordinary one', async () => {
    const { svc, prisma } = await build({ mail: false, user: { hashedPassword: null, googleId: 'g-1' } });
    await svc.changePassword('u1', { googleCredential: 'good', newPassword: 'first-one-1' });
    expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({ hashedPassword: 'hashed:first-one-1' });
  });

  it('refuses a different Google account, or one that is not connected', async () => {
    const { svc } = await build({ mail: false, user: { googleId: 'g-1' } });
    expect(await codeOf(svc.changePassword('u1', { googleCredential: 'someone-elses', newPassword: 'another-one' }))).toBe('GOOGLE_MISMATCH');
    const plain = await build({ mail: false });
    expect(await codeOf(plain.svc.changePassword('u1', { googleCredential: 'good', newPassword: 'another-one' }))).toBe('GOOGLE_NOT_LINKED');
  });

  it('is accepted even when the site could send a code, since an inbox can be unreachable', async () => {
    const { svc } = await build({ mail: true, user: { googleId: 'g-1' } });
    expect(await codeOf(svc.changePassword('u1', { googleCredential: 'good', newPassword: 'another-one' }))).toBe('resolved');
  });
});

describe('account settings — password', () => {
  it('refuses a wrong current password', async () => {
    const { svc, prisma } = await build();
    expect(await codeOf(svc.changePassword('u1', { currentPassword: 'nope', newPassword: 'another-one' }))).toBe('WRONG_PASSWORD');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('stops guessing after five wrong passwords — even the right one waits', async () => {
    const { svc } = await build();
    for (let i = 0; i < 5; i++) await codeOf(svc.changePassword('u1', { currentPassword: 'nope', newPassword: 'another-one' }));
    expect(await codeOf(svc.changePassword('u1', { currentPassword: PASSWORD, newPassword: 'another-one' }))).toBe('TOO_MANY_TRIES');
  });

  it('needs the emailed code when mail is set up, and says why a bad one failed', async () => {
    const { svc } = await build({ mail: true });
    expect(await codeOf(svc.changePassword('u1', { newPassword: 'another-one' }))).toBe('CODE_REQUIRED');
    expect(await codeOf(svc.changePassword('u1', { code: '000000', newPassword: 'another-one' }))).toBe('CODE_INVALID');
    // The password is not a substitute once codes are in use.
    expect(await codeOf(svc.changePassword('u1', { currentPassword: PASSWORD, newPassword: 'another-one' }))).toBe('CODE_REQUIRED');
    expect(await codeOf(svc.changePassword('u1', { code: '123456', newPassword: 'another-one' }))).toBe('resolved');
  });

  it('refuses the password already in use — only after proof, so it is not a guessing oracle', async () => {
    const { svc } = await build();
    expect(await codeOf(svc.changePassword('u1', { currentPassword: 'nope', newPassword: PASSWORD }))).toBe('WRONG_PASSWORD');
    expect(await codeOf(svc.changePassword('u1', { currentPassword: PASSWORD, newPassword: PASSWORD }))).toBe('SAME_PASSWORD');
  });

  it('saves, clears a forced change, and forgets every other remembered browser but this one', async () => {
    const { svc, prisma, twoFactor } = await build();
    const res = await svc.changePassword('u1', { currentPassword: PASSWORD, newPassword: 'another-one' }, 'this-device');
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ hashedPassword: 'hashed:another-one', mustChangePassword: false });
    expect(twoFactor.revokeDevices).toHaveBeenCalledWith('u1', 'this-device');
    expect(res).toMatchObject({ ok: true, devicesForgotten: 2 });
  });

  it('ends every other session, and hands this browser the account to re-issue one from', async () => {
    const { svc, prisma } = await build();
    const before = Date.now();
    const res = await svc.changePassword('u1', { currentPassword: PASSWORD, newPassword: 'another-one' });
    const stamp = prisma.user.update.mock.calls[0][0].data.sessionsValidFrom as Date;
    // The start of the current second: sessions from earlier seconds are void,
    // while the replacement token minted in this one still works.
    expect(stamp.getTime()).toBe(Math.floor(stamp.getTime() / 1000) * 1000);
    expect(stamp.getTime()).toBeLessThanOrEqual(Date.now());
    expect(stamp.getTime()).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    // The controller mints a replacement token from this.
    expect(res.user).toBeDefined();
  });
});

describe('sign out everywhere', () => {
  it('stamps the account and forgets every remembered browser', async () => {
    const { svc, prisma, twoFactor } = await build();
    const before = Date.now();
    const res = await svc.signOutEverywhere('u1');
    const stamp = prisma.user.update.mock.calls[0][0].data.sessionsValidFrom as Date;
    // The NEXT second, so a token issued in this one — another browser signing
    // in as this runs — is void too.
    expect(stamp.getTime()).toBe((Math.floor(stamp.getTime() / 1000)) * 1000);
    expect(stamp.getTime()).toBeGreaterThan(before);
    // Every one, including this browser: the point is to end them all.
    expect(twoFactor.revokeDevices).toHaveBeenCalledWith('u1');
    expect(res).toEqual({ ok: true, devicesForgotten: 2 });
  });
});

describe('account settings — email', () => {
  it('refuses the address you already have', async () => {
    const { svc } = await build();
    expect(await codeOf(svc.changeEmail('u1', { currentPassword: PASSWORD, email: 'CALEB@club.org' }))).toBe('SAME_EMAIL');
  });

  it('refuses an address another account uses — before spending the code', async () => {
    const { svc, prisma, twoFactor } = await build({ mail: true });
    prisma.user.findFirst.mockResolvedValueOnce({ id: 'u2' });
    expect(await codeOf(svc.changeEmail('u1', { code: '123456', email: 'taken@club.org' }))).toBe('EMAIL_TAKEN');
    expect(twoFactor.checkCode).not.toHaveBeenCalled();
  });

  it('refuses an address that can never receive mail, on a site that sends it', async () => {
    const { svc } = await build({ mail: true });
    expect(await codeOf(svc.changeEmail('u1', { code: '123456', email: 'me@example.com' }))).toBe('EMAIL_UNROUTABLE');
  });

  it('saves it lower-cased and unverified, so the next code-gated sign-in proves the new inbox', async () => {
    const { svc, prisma } = await build();
    await svc.changeEmail('u1', { currentPassword: PASSWORD, email: ' New@Club.org ' });
    expect(prisma.user.update.mock.calls[0][0].data).toEqual({ email: 'new@club.org', emailVerified: false, emailVerifiedAt: null });
  });
});

describe('account settings — recovery codes and devices', () => {
  it('makes new recovery codes only with proof', async () => {
    const { svc, twoFactor } = await build();
    expect(await codeOf(svc.newRecoveryCodes('u1', { currentPassword: 'nope' }))).toBe('WRONG_PASSWORD');
    expect(twoFactor.generateRecoveryCodes).not.toHaveBeenCalled();
    expect(await svc.newRecoveryCodes('u1', { currentPassword: PASSWORD })).toEqual({ codes: ['NEW-1'] });
  });

  it('says so when a device is not on your account', async () => {
    const { svc } = await build();
    await expect(svc.forgetDevice('u1', 'someone-elses')).rejects.toThrow('not on your account');
  });
});

describe('account settings — deleting your own account', () => {
  it('needs the username typed out', async () => {
    const { svc, auth } = await build();
    expect(await codeOf(svc.deleteSelf('u1', { currentPassword: PASSWORD, confirm: 'caleb' }))).toBe('CONFIRM_MISMATCH');
    expect(auth.deleteUser).not.toHaveBeenCalled();
  });

  it('will not let the last admin leave the site without one', async () => {
    const { svc, prisma } = await build({ user: { roles: ['ADMIN'] } });
    prisma.user.count.mockResolvedValueOnce(0);
    expect(await codeOf(svc.deleteSelf('u1', { currentPassword: PASSWORD, confirm: 'caleb-ruiz' }))).toBe('LAST_ADMIN');
  });

  it('refuses while you are in a live tournament — before spending the proof', async () => {
    const { svc, prisma, twoFactor } = await build({ mail: true });
    prisma.tournamentParticipant.findMany.mockResolvedValueOnce([{ tournamentId: 't1', tournament: { name: 'Winter Open' } }]);
    expect(await codeOf(svc.deleteSelf('u1', { code: '123456', confirm: 'caleb-ruiz' }))).toBe('ACTIVE_IN_LIVE_TOURNAMENT');
    expect(twoFactor.checkCode).not.toHaveBeenCalled();
  });

  it('deletes through the admin path, then logs it by name only', async () => {
    const { svc, auth, audit } = await build();
    await svc.deleteSelf('u1', { currentPassword: PASSWORD, confirm: 'Caleb-Ruiz' });
    expect(auth.deleteUser).toHaveBeenCalledWith('u1');
    const entry = (audit.record.mock.calls[0] as any[])[0];
    expect(entry.action).toBe('user.delete_self');
    expect(entry.actor.id).toBeUndefined();
    expect(entry.summary).toBe('Caleb Ruiz deleted their own account');
    // Logged after the deletion, never for a refused one.
    expect(auth.deleteUser.mock.invocationCallOrder[0]).toBeLessThan(audit.record.mock.invocationCallOrder[0]);
  });
});

describe('PATCH /auth/me', () => {
  it('no longer accepts a password or an email — those need proof now', async () => {
    const dto = plainToInstance(UpdateMeDto, { bio: 'hi', password: 'sneaky-new', email: 'x@y.org' });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map((e) => e.property).sort()).toEqual(['email', 'password']);
  });

  it('moves the profile address with a self-rename, as an admin rename already did', async () => {
    const prisma: any = {
      user: {
        findUnique: jest.fn(async (args: any) => (args.where.id === 'u1' ? { id: 'u1', username: 'old-name' } : null)),
        findFirst: jest.fn(async () => null),
        update: jest.fn(async ({ data }: any) => ({ id: 'u1', ...data })),
      },
    };
    const svc = new AuthService(prisma, {} as any, {} as any);
    await svc.updateMe('u1', { username: 'new-name' });
    expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({ username: 'new-name', slug: 'new-name' });
  });
});

describe('remembered devices', () => {
  it('keeps the current browser when forgetting the rest, and marks it in the list', async () => {
    const prisma: any = {
      trustedDevice: {
        deleteMany: jest.fn(async () => ({ count: 1 })),
        findMany: jest.fn(async () => [
          { id: 'd1', userAgent: 'A', createdAt: new Date(), lastUsedAt: new Date(), expiresAt: new Date(), tokenHash: 'x' },
        ]),
      },
    };
    const tf = new TwoFactorService(prisma, {} as any, {} as any);
    await tf.revokeDevices('u1', 'mine');
    const where = prisma.trustedDevice.deleteMany.mock.calls[0][0].where;
    expect(where.userId).toBe('u1');
    expect(where.tokenHash.not).toMatch(/^[0-9a-f]{64}$/);

    const list = await tf.listDevices('u1', 'not-that-one');
    expect(list[0]).not.toHaveProperty('tokenHash');
    expect(list[0].current).toBe(false);
  });
});

describe('mail is "set up"', () => {
  const settings = (v: Record<string, string>) => ({ get: async (k: string) => v[k] ?? null });
  it('only for SMTP with host, user and password — the console transport never delivers', async () => {
    expect(await new MailService(settings({}) as any).isConfigured()).toBe(false);
    expect(await new MailService(settings({ MAIL_TRANSPORT: 'console' }) as any).isConfigured()).toBe(false);
    expect(await new MailService(settings({ MAIL_TRANSPORT: 'smtp', MAIL_HOST: 'h' }) as any).isConfigured()).toBe(false);
    expect(
      await new MailService(settings({ MAIL_TRANSPORT: 'smtp', MAIL_HOST: 'h', MAIL_USER: 'u', MAIL_PASS: 'p' }) as any).isConfigured(),
    ).toBe(true);
  });
});
