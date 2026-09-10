import { TwoFactorService } from '../src/auth/two-factor.service';
import * as bcrypt from 'bcrypt';

// These are the rules that decide whether emailed 2FA is real security or
// decoration: codes must expire, be single-use, survive only a few guesses, and
// a device cookie must not work for a different account.
describe('TwoFactorService', () => {
  const build = (overrides: any = {}) => {
    const prisma: any = {
      twoFactorCode: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({}),
      },
      user: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      trustedDevice: {
        create: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: jest.fn().mockResolvedValue([]),
      ...overrides.prisma,
    };
    const mail = { send: jest.fn().mockResolvedValue({ delivered: true, transport: 'console' }) };
    const settings = { get: jest.fn().mockResolvedValue(overrides.enforcement ?? 'all') };
    return { prisma, mail, service: new TwoFactorService(prisma, mail as any, settings as any) };
  };

  describe('issuing', () => {
    it('emails a 6-digit code and stores only its hash', async () => {
      const { prisma, mail, service } = build();
      const result = await service.issueCode({ id: 'u1', email: 'a@example.com' }, 'signin');
      expect(result.sent).toBe(true);
      const body = mail.send.mock.calls[0][0].text as string;
      const code = body.match(/\b(\d{6})\b/)![1];
      const created = prisma.$transaction.mock.calls[0][0][1];
      expect(created).toBeDefined();
      // The plaintext code must never be what gets stored.
      expect(JSON.stringify(prisma.$transaction.mock.calls[0])).not.toContain(code);
    });

    it('refuses an account with no address instead of pretending to send', async () => {
      const { service } = build();
      const result = await service.issueCode({ id: 'u1', email: null }, 'signin');
      expect(result).toMatchObject({ sent: false });
      expect(result.error).toMatch(/no email/i);
    });

    it('throttles resends', async () => {
      const { service } = build({
        prisma: {
          twoFactorCode: {
            findFirst: jest.fn().mockResolvedValue({ id: 'c1', createdAt: new Date(), consumedAt: null }),
            create: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
          },
        },
      });
      const result = await service.issueCode({ id: 'u1', email: 'a@example.com' }, 'signin');
      expect(result.sent).toBe(false);
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('throttles even when the previous code was already burned', async () => {
      // Otherwise five wrong guesses burn a code and a new one can be had
      // instantly: five guesses per email, no delay, and a way to flood an inbox.
      const { service } = build({
        prisma: {
          twoFactorCode: {
            findFirst: jest.fn().mockResolvedValue({
              id: 'c1',
              createdAt: new Date(),
              consumedAt: new Date(), // consumed, but only moments ago
            }),
            create: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
          },
        },
      });
      const result = await service.issueCode({ id: 'u1', email: 'a@example.com' }, 'signin');
      expect(result.sent).toBe(false);
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('issues immediately when the previous code was entered correctly', async () => {
      // Signing out and back in within the minute is ordinary. Throttling it
      // dead-ends the account: the fresh challenge has no pending code, so the
      // screen says "No code is pending" and the resend that would fix it is
      // throttled too. A success already proved inbox access, so it floods nothing.
      const { service, mail } = build({
        prisma: {
          twoFactorCode: {
            findFirst: jest.fn().mockResolvedValue({
              id: 'c1',
              createdAt: new Date(),
              consumedAt: new Date(),
              succeededAt: new Date(), // entered correctly, moments ago
            }),
            create: jest.fn().mockResolvedValue({}),
            update: jest.fn(),
            updateMany: jest.fn(),
          },
        },
      });
      const result = await service.issueCode({ id: 'u1', email: 'a@example.com' }, 'signin');
      expect(result.sent).toBe(true);
      expect(mail.send).toHaveBeenCalled();
    });

    it('reports a delivery failure rather than claiming success', async () => {
      const { service, mail } = build();
      mail.send.mockResolvedValueOnce({ delivered: false, transport: 'smtp', error: 'relay refused' });
      const result = await service.issueCode({ id: 'u1', email: 'a@example.com' }, 'signin');
      expect(result).toMatchObject({ sent: false, error: 'relay refused' });
    });
  });

  describe('checking', () => {
    const rowWith = async (code: string, extra: any = {}) => ({
      id: 'c1',
      userId: 'u1',
      codeHash: await bcrypt.hash(code, 4),
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      attempts: 0,
      createdAt: new Date(),
      ...extra,
    });

    it('accepts the right code once', async () => {
      const row = await rowWith('123456');
      const { prisma, service } = build({
        prisma: { twoFactorCode: { findFirst: jest.fn().mockResolvedValue(row), update: jest.fn(), create: jest.fn(), updateMany: jest.fn() } },
      });
      await expect(service.checkCode('u1', '123456')).resolves.toEqual({ ok: true });
      // Consumed, so a replay finds nothing — and marked as a SUCCESS, which is
      // what exempts the next sign-in from the resend throttle.
      expect(prisma.twoFactorCode.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            consumedAt: expect.any(Date),
            succeededAt: expect.any(Date),
          }),
        }),
      );
    });

    it('rejects an expired code', async () => {
      const row = await rowWith('123456', { expiresAt: new Date(Date.now() - 1000) });
      const { service } = build({
        prisma: { twoFactorCode: { findFirst: jest.fn().mockResolvedValue(row), update: jest.fn(), create: jest.fn(), updateMany: jest.fn() } },
      });
      await expect(service.checkCode('u1', '123456')).resolves.toEqual({ ok: false, reason: 'expired' });
    });

    it('burns the code after five wrong guesses', async () => {
      const row = await rowWith('123456', { attempts: 4 });
      const { prisma, service } = build({
        prisma: { twoFactorCode: { findFirst: jest.fn().mockResolvedValue(row), update: jest.fn(), create: jest.fn(), updateMany: jest.fn() } },
      });
      await expect(service.checkCode('u1', '000000')).resolves.toEqual({ ok: false, reason: 'exhausted' });
      expect(prisma.twoFactorCode.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ attempts: 5, consumedAt: expect.any(Date) }) }),
      );
    });

    it('reports "none" when there is no live code', async () => {
      const { service } = build();
      await expect(service.checkCode('u1', '123456')).resolves.toEqual({ ok: false, reason: 'none' });
    });
  });

  describe('trusted devices', () => {
    it('does not accept a device cookie belonging to another user', async () => {
      // The cookie is valid and unexpired — it just is not this account's.
      const { service } = build({
        prisma: {
          trustedDevice: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'd1', userId: 'someone-else', expiresAt: new Date(Date.now() + 60_000),
            }),
            create: jest.fn(), update: jest.fn(), delete: jest.fn(), deleteMany: jest.fn(),
          },
        },
      });
      await expect(service.isTrustedDevice('u1', 'sometoken')).resolves.toBe(false);
    });

    it('rejects and cleans up an expired device', async () => {
      const { prisma, service } = build({
        prisma: {
          trustedDevice: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'd1', userId: 'u1', expiresAt: new Date(Date.now() - 1000),
            }),
            create: jest.fn(), update: jest.fn(), delete: jest.fn().mockResolvedValue({}), deleteMany: jest.fn(),
          },
        },
      });
      await expect(service.isTrustedDevice('u1', 'sometoken')).resolves.toBe(false);
      expect(prisma.trustedDevice.delete).toHaveBeenCalled();
    });

    it('stores only a hash of the device token', async () => {
      const { prisma, service } = build();
      const token = await service.trustDevice('u1', 'Firefox');
      const stored = prisma.trustedDevice.create.mock.calls[0][0].data.tokenHash;
      expect(stored).not.toBe(token);
      expect(stored).toHaveLength(64); // sha256 hex
    });
  });

  describe('enforcement', () => {
    it('exempts guests regardless of mode', async () => {
      const { service } = build();
      await expect(service.isRequiredFor({ roles: ['PLAYER'], isGuest: true })).resolves.toBe(false);
    });

    it('honours staff-only mode', async () => {
      const { service } = build({ enforcement: 'staff' });
      await expect(service.isRequiredFor({ roles: ['PLAYER'], isGuest: false })).resolves.toBe(false);
      await expect(service.isRequiredFor({ roles: ['ORGANIZER'], isGuest: false })).resolves.toBe(true);
    });

    it('lets the in-memory dev override win over the stored setting', async () => {
      const { service } = build({ enforcement: 'all' });
      TwoFactorService.enforcementOverride = 'off';
      await expect(service.isRequiredFor({ roles: ['ADMIN'], isGuest: false })).resolves.toBe(false);
      TwoFactorService.enforcementOverride = null;
      await expect(service.isRequiredFor({ roles: ['ADMIN'], isGuest: false })).resolves.toBe(true);
    });
  });
});
