import { SettingsService } from '../src/settings/settings.service';
import { encryptSetting, decryptSetting } from '../src/settings/settings.crypto';

describe('settings', () => {
  const KEY = 'a'.repeat(64); // 32 bytes of hex
  const originalKey = process.env.SETTINGS_ENCRYPTION_KEY;
  const originalHost = process.env.MAIL_HOST;

  beforeAll(() => { process.env.SETTINGS_ENCRYPTION_KEY = KEY; });
  afterAll(() => {
    if (originalKey === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
    else process.env.SETTINGS_ENCRYPTION_KEY = originalKey;
    if (originalHost === undefined) delete process.env.MAIL_HOST;
    else process.env.MAIL_HOST = originalHost;
  });

  describe('encryption', () => {
    it('round-trips a secret', () => {
      const secret = 'xsmtpsib-super-secret-key';
      expect(decryptSetting(encryptSetting(secret))).toBe(secret);
    });

    it('produces different ciphertext each time (random IV)', () => {
      // Otherwise identical secrets are visibly identical in the database.
      expect(encryptSetting('same')).not.toBe(encryptSetting('same'));
    });

    it('refuses tampered ciphertext instead of returning rubbish', () => {
      // GCM is authenticated: this is what stops a modified row being used as a
      // password without anyone noticing.
      const stored = encryptSetting('original');
      const [v, iv, tag] = stored.split(':');
      const tampered = [v, iv, tag, Buffer.from('evil').toString('base64')].join(':');
      expect(() => decryptSetting(tampered)).toThrow();
    });

    it('rejects a key that is not 32 bytes', () => {
      process.env.SETTINGS_ENCRYPTION_KEY = 'tooshort';
      expect(() => encryptSetting('x')).toThrow(/32 bytes/);
      process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    });
  });

  describe('resolution order', () => {
    const build = (row: any) => {
      const prisma = {
        systemSetting: {
          findUnique: jest.fn().mockResolvedValue(row),
          upsert: jest.fn().mockResolvedValue({}),
          delete: jest.fn().mockResolvedValue({}),
        },
      } as any;
      return { prisma, service: new SettingsService(prisma) };
    };

    it('prefers the stored value over env', async () => {
      process.env.MAIL_HOST = 'from-env.example.com';
      const { service } = build({ key: 'mail.host', value: 'from-db.example.com', encrypted: false });
      expect(await service.get('MAIL_HOST')).toBe('from-db.example.com');
    });

    it('falls back to env when nothing is stored', async () => {
      process.env.MAIL_HOST = 'from-env.example.com';
      const { service } = build(null);
      expect(await service.get('MAIL_HOST')).toBe('from-env.example.com');
    });

    it('falls back to the default when neither is set', async () => {
      delete process.env.MAIL_HOST;
      const { service } = build(null);
      expect(await service.get('MAIL_HOST')).toBe('smtp-relay.brevo.com');
    });

    it('decrypts a stored secret transparently', async () => {
      const { service } = build({ key: 'mail.pass', value: encryptSetting('the-smtp-key'), encrypted: true });
      expect(await service.get('MAIL_PASS')).toBe('the-smtp-key');
    });

    it('caches reads so login does not hit the database every time', async () => {
      const { prisma, service } = build({ key: 'mail.host', value: 'cached.example.com', encrypted: false });
      await service.get('MAIL_HOST');
      await service.get('MAIL_HOST');
      expect(prisma.systemSetting.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('admin listing', () => {
    it('never returns a secret value, only whether it is configured', async () => {
      const prisma = {
        systemSetting: {
          findUnique: jest.fn().mockImplementation(({ where }: any) =>
            where.key === 'mail.pass'
              ? { key: 'mail.pass', value: encryptSetting('the-smtp-key'), encrypted: true }
              : null,
          ),
        },
      } as any;
      const listed = await new SettingsService(prisma).listForAdmin();
      const pass = listed.find((s) => s.key === 'mail.pass')!;
      expect(pass.secret).toBe(true);
      expect(pass.configured).toBe(true);
      expect(pass.value).toBeNull();
      // And the plaintext must not appear anywhere in the payload.
      expect(JSON.stringify(listed)).not.toContain('the-smtp-key');
    });
  });
});
