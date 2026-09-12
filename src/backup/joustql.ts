import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { requireSettingsKey } from '../settings/settings.crypto';

/**
 * `.joustql` — the backup container format.
 *
 * A bare `.dump` invites someone to import an unrelated Postgres database and
 * find out it did not fit halfway through a restore, when the target is already
 * dropped. So a backup is a self-describing file this app can recognise and
 * refuse:
 *
 *     JOUSTQL1\n                 magic + format version
 *     {"createdAt":...}\n        manifest, one line of JSON
 *     <payload bytes>            pg_dump -Fc output, optionally encrypted
 *
 * The manifest stays PLAINTEXT even when the payload is encrypted: listing the
 * backups, checking which schema they came from and showing their labels must
 * all work without the encryption key. Nothing in the manifest is sensitive —
 * the addresses and hashes are in the payload.
 *
 * The payload is not gzipped: `pg_dump -Fc` is already zlib-compressed, so a
 * second pass buys nothing but CPU.
 */

export const MAGIC = 'JOUSTQL1';
const IV_BYTES = 12; // GCM standard

export type BackupTrigger = 'manual' | 'scheduled' | 'uploaded' | 'pre-restore';

export interface JoustqlManifest {
  /** Bumped only if the layout above changes incompatibly. */
  format: 1;
  createdAt: string;
  /** Database the dump was taken from — informational, restores are by URL. */
  database: string;
  /** Latest applied `_prisma_migrations` row. The one field that decides
   *  whether this file can be restored here at all. */
  schemaMigration: string | null;
  trigger: BackupTrigger;
  alias: string | null;
  description: string | null;
  /** Exempt from rolling deletion. */
  pinned: boolean;
  /** Addresses and credentials scrubbed (see sanitize.sql). */
  sanitized: boolean;
  encrypted: boolean;
  /** Over the payload BEFORE encryption, so it verifies the dump itself
   *  rather than the envelope GCM already authenticates. */
  payloadSha256: string;
  payloadBytes: number;
  /** Present only when encrypted. */
  iv?: string;
  authTag?: string;
}

/** Carries a machine-readable reason so the API can say WHY a file was
 *  rejected — "not a JOUST backup" and "from a newer schema" need different
 *  answers from whoever is holding the file. */
export class JoustqlError extends Error {
  constructor(
    public readonly code:
      | 'NOT_JOUSTQL'
      | 'BAD_FORMAT'
      | 'CHECKSUM_MISMATCH'
      | 'SCHEMA_MISMATCH'
      | 'DECRYPT_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'JoustqlError';
  }
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/**
 * Write a backup file. `payload` is raw `pg_dump -Fc` output.
 *
 * Sanitized exports are deliberately left unencrypted: there is nothing left in
 * them worth protecting, and they are the copies meant to be handed to someone
 * else — a file that needs a key to open is a bad demo artefact.
 */
export async function writeJoustql(
  path: string,
  payload: Buffer,
  meta: Omit<
    JoustqlManifest,
    'format' | 'payloadSha256' | 'payloadBytes' | 'iv' | 'authTag' | 'encrypted'
  > & { encrypt: boolean },
): Promise<JoustqlManifest> {
  const { encrypt, ...rest } = meta;
  const manifest: JoustqlManifest = {
    format: 1,
    ...rest,
    encrypted: encrypt,
    payloadSha256: sha256(payload),
    payloadBytes: payload.length,
  };

  let body = payload;
  if (encrypt) {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', requireSettingsKey(), iv);
    body = Buffer.concat([cipher.update(payload), cipher.final()]);
    manifest.iv = iv.toString('base64');
    manifest.authTag = cipher.getAuthTag().toString('base64');
  }

  await fs.writeFile(
    path,
    Buffer.concat([
      Buffer.from(`${MAGIC}\n${JSON.stringify(manifest)}\n`, 'utf8'),
      body,
    ]),
  );
  return manifest;
}

interface ParsedHeader {
  manifest: JoustqlManifest;
  /** Byte offset where the payload starts. */
  offset: number;
}

function parseHeader(head: Buffer): ParsedHeader {
  const firstBreak = head.indexOf(0x0a);
  if (firstBreak < 0 || head.subarray(0, firstBreak).toString() !== MAGIC) {
    throw new JoustqlError(
      'NOT_JOUSTQL',
      'This is not a JOUST backup file. Backups are created by Admin → Backups and end in .joustql.',
    );
  }
  const secondBreak = head.indexOf(0x0a, firstBreak + 1);
  if (secondBreak < 0) {
    throw new JoustqlError('BAD_FORMAT', 'The backup header is truncated.');
  }

  let manifest: JoustqlManifest;
  try {
    manifest = JSON.parse(
      head.subarray(firstBreak + 1, secondBreak).toString('utf8'),
    ) as JoustqlManifest;
  } catch {
    throw new JoustqlError('BAD_FORMAT', 'The backup manifest is not readable.');
  }
  if (manifest.format !== 1) {
    throw new JoustqlError(
      'BAD_FORMAT',
      `This backup uses format version ${manifest.format}, which this server does not understand.`,
    );
  }
  return { manifest, offset: secondBreak + 1 };
}

/**
 * Read just the manifest. Listing a directory of backups must not load, decrypt
 * or checksum megabytes of dump per row.
 */
export async function readManifest(path: string): Promise<JoustqlManifest> {
  const handle = await fs.open(path, 'r');
  try {
    // The magic plus a manifest of this shape is comfortably inside 8KB.
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return parseHeader(buf.subarray(0, bytesRead)).manifest;
  } finally {
    await handle.close();
  }
}

/** Read and verify the payload, decrypting when needed. */
export async function readPayload(
  path: string,
): Promise<{ manifest: JoustqlManifest; payload: Buffer }> {
  const file = await fs.readFile(path);
  const { manifest, offset } = parseHeader(file.subarray(0, 8192));
  let payload = file.subarray(offset);

  if (manifest.encrypted) {
    if (!manifest.iv || !manifest.authTag) {
      throw new JoustqlError(
        'BAD_FORMAT',
        'The backup is marked encrypted but carries no key material.',
      );
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        requireSettingsKey(),
        Buffer.from(manifest.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(manifest.authTag, 'base64'));
      payload = Buffer.concat([decipher.update(payload), decipher.final()]);
    } catch {
      // Overwhelmingly the cause is a different SETTINGS_ENCRYPTION_KEY, so say
      // that rather than "decryption failed" — it is the difference between a
      // lost backup and one that opens on the machine that made it.
      throw new JoustqlError(
        'DECRYPT_FAILED',
        'Could not decrypt this backup. It was encrypted with a different SETTINGS_ENCRYPTION_KEY than this server has.',
      );
    }
  }

  if (sha256(payload) !== manifest.payloadSha256) {
    throw new JoustqlError(
      'CHECKSUM_MISMATCH',
      'This backup is corrupted — its contents do not match its checksum.',
    );
  }
  return { manifest, payload };
}

/** Rewrite the manifest of an existing file, leaving the payload untouched.
 *  Used for labelling and pinning after the fact. */
export async function rewriteManifest(
  path: string,
  patch: Partial<Pick<JoustqlManifest, 'alias' | 'description' | 'pinned'>>,
): Promise<JoustqlManifest> {
  const file = await fs.readFile(path);
  const { manifest, offset } = parseHeader(file.subarray(0, 8192));
  const updated: JoustqlManifest = { ...manifest, ...patch };
  await fs.writeFile(
    path,
    Buffer.concat([
      Buffer.from(`${MAGIC}\n${JSON.stringify(updated)}\n`, 'utf8'),
      file.subarray(offset),
    ]),
  );
  return updated;
}
