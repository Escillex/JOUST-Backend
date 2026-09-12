import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { BackupService } from '../src/backup/backup.service';
import {
  JoustqlError,
  readManifest,
  readPayload,
  rewriteManifest,
  writeJoustql,
} from '../src/backup/joustql';

/**
 * What has to hold for a backup feature to be worth having: the file must be
 * recognisable, tamper-evident, and impossible to confuse with someone else's
 * database — and the destructive half must be shut unless deliberately opened.
 */
describe('backups', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `joust-backup-test-${randomBytes(6).toString('hex')}`);
    await fs.mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const meta = (over: Partial<Parameters<typeof writeJoustql>[2]> = {}) => ({
    createdAt: new Date().toISOString(),
    database: 'trinity',
    schemaMigration: '20260911030000_two_factor_code_succeeded',
    trigger: 'manual' as const,
    alias: null,
    description: null,
    pinned: false,
    sanitized: false,
    encrypt: true,
    ...over,
  });

  describe('the .joustql container', () => {
    it('round-trips an encrypted payload', async () => {
      const path = join(dir, 'a.joustql');
      const payload = randomBytes(2048);
      await writeJoustql(path, payload, meta());

      const { manifest, payload: back } = await readPayload(path);
      expect(manifest.encrypted).toBe(true);
      expect(back.equals(payload)).toBe(true);
    });

    it('leaves the manifest readable without the encryption key', async () => {
      // Listing backups, and telling which schema they came from, must work on a
      // machine that cannot decrypt them.
      const path = join(dir, 'b.joustql');
      await writeJoustql(path, randomBytes(64), meta({ alias: 'defense' }));

      const key = process.env.SETTINGS_ENCRYPTION_KEY;
      delete process.env.SETTINGS_ENCRYPTION_KEY;
      try {
        const manifest = await readManifest(path);
        expect(manifest.alias).toBe('defense');
        expect(manifest.schemaMigration).toContain('two_factor_code_succeeded');
      } finally {
        process.env.SETTINGS_ENCRYPTION_KEY = key;
      }
    });

    it('keeps the payload unreadable on disk', async () => {
      const path = join(dir, 'c.joustql');
      await writeJoustql(path, Buffer.from('admin@joust.local secret'), meta());
      const raw = await fs.readFile(path);
      // The manifest is plaintext; the payload must not be.
      expect(raw.includes(Buffer.from('admin@joust.local'))).toBe(false);
    });

    it('refuses a file that is not a backup', async () => {
      const path = join(dir, 'd.joustql');
      await fs.writeFile(path, Buffer.from('PGDMP not really'));
      await expect(readPayload(path)).rejects.toMatchObject({ code: 'NOT_JOUSTQL' });
    });

    it('detects a corrupted payload', async () => {
      const path = join(dir, 'e.joustql');
      await writeJoustql(path, randomBytes(512), meta({ encrypt: false }));
      const raw = await fs.readFile(path);
      raw[raw.length - 5] ^= 0xff; // flip a bit in the payload
      await fs.writeFile(path, raw);
      await expect(readPayload(path)).rejects.toMatchObject({
        code: 'CHECKSUM_MISMATCH',
      });
    });

    it('reports a wrong encryption key as such, not as corruption', async () => {
      const path = join(dir, 'f.joustql');
      await writeJoustql(path, randomBytes(256), meta());
      const key = process.env.SETTINGS_ENCRYPTION_KEY;
      process.env.SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString('hex');
      try {
        await expect(readPayload(path)).rejects.toMatchObject({
          code: 'DECRYPT_FAILED',
        });
      } finally {
        process.env.SETTINGS_ENCRYPTION_KEY = key;
      }
    });

    it('relabels without touching the payload', async () => {
      const path = join(dir, 'g.joustql');
      const payload = randomBytes(1024);
      await writeJoustql(path, payload, meta());
      await rewriteManifest(path, { alias: 'defense-baseline', pinned: true });

      const { manifest, payload: back } = await readPayload(path);
      expect(manifest.alias).toBe('defense-baseline');
      expect(manifest.pinned).toBe(true);
      expect(back.equals(payload)).toBe(true);
    });
  });

  describe('the service', () => {
    const build = (settings: Record<string, string>) => {
      const svc = new BackupService(
        { $connect: jest.fn(), $disconnect: jest.fn(), $queryRawUnsafe: jest.fn() } as any,
        {
          get: jest.fn(async (n: string) => settings[n] ?? null),
          getBoolean: jest.fn(async (n: string) => settings[n] === 'true'),
          clearCache: jest.fn(),
        } as any,
      );
      return svc;
    };

    it('refuses a restore unless it has been deliberately allowed', async () => {
      // The switch is the gate, not the button's disabled state.
      const svc = build({ BACKUP_DIR: dir, BACKUP_ALLOW_RESTORE: 'false' });
      await expect(svc.assertRestoreAllowed()).rejects.toThrow(/disabled/i);

      const open = build({ BACKUP_DIR: dir, BACKUP_ALLOW_RESTORE: 'true' });
      await expect(open.assertRestoreAllowed()).resolves.toBeUndefined();
    });

    it.each([
      ['../../etc/passwd', 'traversal'],
      ['/etc/passwd', 'absolute'],
      ['joust-20260911-0430.dump', 'foreign extension'],
      ['backup.joustql', 'no timestamp'],
      ['joust-20260911-0430-../evil.joustql', 'traversal inside the alias'],
    ])('rejects %s (%s)', async (name) => {
      const svc = build({ BACKUP_DIR: dir });
      await expect(svc.pathFor(name)).rejects.toThrow(/valid backup name/i);
    });

    it('rolls off the oldest, and never a pinned one', async () => {
      const svc = build({ BACKUP_DIR: dir, BACKUP_RETENTION: '2' });
      // Four backups, oldest first; the oldest is pinned.
      const stamps = ['20260901-010000', '20260902-010000', '20260903-010000', '20260904-010000'];
      for (const [i, stamp] of stamps.entries()) {
        await writeJoustql(
          join(dir, `joust-${stamp}.joustql`),
          randomBytes(32),
          meta({
            createdAt: `2026-09-0${i + 1}T01:00:00.000Z`,
            pinned: i === 0,
            alias: i === 0 ? 'defense-baseline' : null,
          }),
        );
      }

      expect(await svc.prune()).toBe(1);
      const left = (await svc.list()).map((b) => b.name).sort();
      // The pinned one survives even though it is the oldest of the four.
      expect(left).toEqual([
        'joust-20260901-010000.joustql',
        'joust-20260903-010000.joustql',
        'joust-20260904-010000.joustql',
      ]);
    });

    it('rejects an import that is not a backup, with the reason', async () => {
      const svc = build({ BACKUP_DIR: dir });
      const junk = join(dir, 'upload.joustql');
      await fs.writeFile(junk, Buffer.from('-- just some SQL'));
      await expect(svc.importFile(junk, 'upload.joustql')).rejects.toMatchObject({
        response: { code: 'NOT_JOUSTQL' },
      });
    });

    it('does not exit when it is not PID 1', () => {
      // Under `nest start --watch` the app is a child of the watcher: exiting
      // kills the server while the container stays "Up" and nothing restarts it.
      const svc = build({});
      expect(process.pid).not.toBe(1);
      expect(svc.scheduleRestart()).toBe(false);
    });
  });

  it('exports a JoustqlError shape the API can turn into a message', () => {
    const err = new JoustqlError('SCHEMA_MISMATCH', 'from another schema');
    expect(err.code).toBe('SCHEMA_MISMATCH');
    expect(err.message).toContain('another schema');
  });
});
