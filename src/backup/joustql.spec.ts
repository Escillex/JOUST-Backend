import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import {
  JoustqlError,
  readManifest,
  readPayload,
  writeJoustql,
  CURRENT_FORMAT,
} from './joustql';
import { SANITIZE_SQL, SANITIZE_VERIFY_SQL } from './sanitize';

/**
 * Format 2 exists so a backup can be opened on a machine other than the one
 * that wrote it (todo.md §6). These guard the two claims that matters rests on:
 * a passphrase file travels, and a format 1 file still opens here.
 */

const PAYLOAD = Buffer.from('pretend pg_dump -Fc output', 'utf8');
const KEY = 'a'.repeat(64); // 32 bytes of hex

function meta(extra: Record<string, unknown> = {}) {
  return {
    createdAt: new Date().toISOString(),
    database: 'joust',
    schemaMigration: '20260916020000_user_game',
    trigger: 'manual' as const,
    alias: null,
    description: null,
    pinned: false,
    sanitized: false,
    ...extra,
  };
}

describe('joustql', () => {
  let dir: string;
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(async () => {
    dir = join(tmpdir(), `joustql-spec-${randomBytes(4).toString('hex')}`);
    await fs.mkdir(dir, { recursive: true });
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    await fs.rm(dir, { recursive: true, force: true });
  });

  const file = (n: string) => join(dir, n);

  it('round-trips a passphrase-encrypted backup', async () => {
    const path = file('pass.joustql');
    const manifest = await writeJoustql(path, PAYLOAD, {
      ...meta(),
      encryption: 'passphrase',
      passphrase: 'correct horse battery staple',
    });

    expect(manifest.format).toBe(CURRENT_FORMAT);
    expect(manifest.encryption).toBe('passphrase');
    expect(manifest.kdf?.salt).toBeTruthy();

    const { payload } = await readPayload(path, 'correct horse battery staple');
    expect(payload.equals(PAYLOAD)).toBe(true);
  });

  it('opens a passphrase backup even when this server has a different key', async () => {
    // The whole point of format 2: portability. Written with one server key,
    // read with another — only the passphrase matters.
    const path = file('portable.joustql');
    await writeJoustql(path, PAYLOAD, {
      ...meta(),
      encryption: 'passphrase',
      passphrase: 'travels fine',
    });

    process.env.SETTINGS_ENCRYPTION_KEY = 'b'.repeat(64);

    const { payload } = await readPayload(path, 'travels fine');
    expect(payload.equals(PAYLOAD)).toBe(true);
  });

  it('asks for the passphrase rather than reporting a failure', async () => {
    const path = file('needs-pass.joustql');
    await writeJoustql(path, PAYLOAD, {
      ...meta(),
      encryption: 'passphrase',
      passphrase: 'a passphrase',
    });

    // PASSPHRASE_REQUIRED is distinct from DECRYPT_FAILED so the caller can
    // prompt instead of telling somebody their backup is broken.
    await expect(readPayload(path)).rejects.toMatchObject({
      code: 'PASSPHRASE_REQUIRED',
    });
  });

  it('rejects a wrong passphrase with a message about the passphrase', async () => {
    const path = file('wrong.joustql');
    await writeJoustql(path, PAYLOAD, {
      ...meta(),
      encryption: 'passphrase',
      passphrase: 'the right one',
    });

    await expect(readPayload(path, 'the wrong one')).rejects.toMatchObject({
      code: 'DECRYPT_FAILED',
      message: expect.stringContaining('passphrase'),
    });
  });

  it('still reads a format 1 file keyed to this server', async () => {
    // Hand-rolled rather than written through writeJoustql, which only emits
    // format 2 now — this is the compatibility case that must not regress.
    const path = file('legacy.joustql');
    const v2 = file('src.joustql');
    await writeJoustql(v2, PAYLOAD, { ...meta(), encryption: 'serverKey' });

    const raw = await fs.readFile(v2);
    const firstBreak = raw.indexOf(0x0a);
    const secondBreak = raw.indexOf(0x0a, firstBreak + 1);
    const manifest = JSON.parse(
      raw.subarray(firstBreak + 1, secondBreak).toString('utf8'),
    ) as Record<string, unknown>;

    // Exactly what a pre-2026-09-16 file looks like: format 1, `encrypted`, and
    // no `encryption` discriminator at all.
    manifest.format = 1;
    delete manifest.encryption;
    await fs.writeFile(
      path,
      Buffer.concat([
        Buffer.from(`JOUSTQL1\n${JSON.stringify(manifest)}\n`, 'utf8'),
        raw.subarray(secondBreak + 1),
      ]),
    );

    const { manifest: read, payload } = await readPayload(path);
    expect(read.format).toBe(1);
    expect(payload.equals(PAYLOAD)).toBe(true);
  });

  it('refuses to write an encrypted backup with no passphrase', async () => {
    await expect(
      writeJoustql(file('x.joustql'), PAYLOAD, {
        ...meta(),
        encryption: 'passphrase',
      }),
    ).rejects.toBeInstanceOf(JoustqlError);
  });

  it('leaves a sanitized export unencrypted and readable by anyone', async () => {
    const path = file('sanitized.joustql');
    await writeJoustql(path, PAYLOAD, {
      ...meta({ sanitized: true }),
      encryption: 'none',
    });

    delete process.env.SETTINGS_ENCRYPTION_KEY;
    const { manifest, payload } = await readPayload(path);
    expect(manifest.encrypted).toBe(false);
    expect(payload.equals(PAYLOAD)).toBe(true);
  });

  it('keeps the manifest readable without any key', async () => {
    const path = file('listing.joustql');
    await writeJoustql(path, PAYLOAD, {
      ...meta({ alias: 'defense-baseline' }),
      encryption: 'passphrase',
      passphrase: 'secret',
    });

    delete process.env.SETTINGS_ENCRYPTION_KEY;
    // Listing a directory of backups must not need a passphrase per row.
    const manifest = await readManifest(path);
    expect(manifest.alias).toBe('defense-baseline');
    expect(manifest.encrypted).toBe(true);
  });
});

describe('sanitize SQL', () => {
  it('removes environment settings, not just the encrypted ones', () => {
    // The 2026-09-16 defect: deleting only `encrypted = true` rows left
    // mail.host / mail.user / mail.from in an UNENCRYPTED export.
    expect(SANITIZE_SQL).toContain(`"key" LIKE 'mail.%'`);
    expect(SANITIZE_SQL).toContain(`"encrypted" = true`);
  });

  it('drops every uploaded-image reference the bundle cannot carry', () => {
    for (const fragment of [
      `UPDATE "User" SET "avatarUrl" = NULL`,
      `UPDATE "Game" SET "iconUrl" = NULL`,
      `UPDATE "Tournament" SET "bannerUrl" = NULL`,
      `UPDATE "Tournament" SET "prizeImageUrl" = NULL`,
      `UPDATE "TournamentBuild" SET "imageUrl" = NULL`,
      `DELETE FROM "GalleryImage"`,
    ]) {
      expect(SANITIZE_SQL).toContain(fragment);
    }
  });

  it('verifies every claim it makes, and returns one number', () => {
    // The guard used to inspect "User" alone, so it could never have caught the
    // settings leak it sits next to.
    expect(SANITIZE_VERIFY_SQL).toContain('"SystemSetting"');
    expect(SANITIZE_VERIFY_SQL).toContain('"GalleryImage"');
    expect(SANITIZE_VERIFY_SQL).toContain('avatarUrl');
    expect(SANITIZE_VERIFY_SQL).toMatch(/AS leaked/);
    // The caller reads the first integer out of psql's output.
    expect(SANITIZE_VERIFY_SQL.match(/AS leaked/g)).toHaveLength(1);
  });
});
