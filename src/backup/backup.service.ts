import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { execFile } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';
import { promisify } from 'util';
import { PrismaService } from 'prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import {
  BackupTrigger,
  JoustqlError,
  JoustqlManifest,
  readManifest,
  readPayload,
  rewriteManifest,
  writeJoustql,
} from './joustql';
import {
  SANITIZED_PASSWORD_PLAINTEXT,
  SANITIZE_SQL,
  SANITIZE_VERIFY_SQL,
} from './sanitize';

const run = promisify(execFile);

/** Timestamp first, always: a backup may be aliased "defense-baseline", but you
 *  still have to be able to see at a glance when it was taken. */
const FILENAME = /^joust-\d{8}-\d{6}(-[a-z0-9][a-z0-9-]{0,40})?\.joustql$/;

export interface BackupListEntry extends JoustqlManifest {
  name: string;
  fileBytes: number;
}

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  // ─── Location ───────────────────────────────────────────────────────────

  /**
   * Project-relative by default, so the whole feature travels: the same compose
   * on a VPS puts backups in the same place, and nothing here bakes in a path
   * from this machine.
   */
  async directory(): Promise<string> {
    const configured = (await this.settings.get('BACKUP_DIR'))?.trim();
    const dir = configured || resolve(process.cwd(), 'backups');
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * The single choke point for anything that arrives as a name. Download,
   * delete and restore all address a file by name, and path traversal is the
   * obvious attack on all three.
   */
  private async resolveFile(name: string): Promise<string> {
    if (!FILENAME.test(name)) {
      throw new BadRequestException('Not a valid backup name.');
    }
    const path = join(await this.directory(), name);
    try {
      await fs.access(path);
    } catch {
      throw new NotFoundException('That backup no longer exists.');
    }
    return path;
  }

  // ─── Database plumbing ──────────────────────────────────────────────────

  /**
   * DATABASE_URL as libpq will accept it.
   *
   * Prisma's URL carries parameters libpq has never heard of — `schema` above
   * all, which every DATABASE_URL in this project sets — and pg_dump rejects
   * the whole URI rather than ignoring them: `invalid URI query parameter:
   * "schema"`. So the Prisma-only keys are stripped, and a non-default schema
   * is translated into the `options` parameter libpq does understand.
   */
  private databaseUrl(): string {
    const raw = process.env.DATABASE_URL;
    if (!raw) throw new Error('DATABASE_URL is not set.');

    const url = new URL(raw);
    const schema = url.searchParams.get('schema');
    for (const key of [
      'schema',
      'connection_limit',
      'pool_timeout',
      'pgbouncer',
      'socket_timeout',
      'statement_cache_size',
      'sslidentity',
      'sslpassword',
      'sslcert',
    ]) {
      url.searchParams.delete(key);
    }
    if (schema && schema !== 'public') {
      url.searchParams.set('options', `-c search_path=${schema}`);
    }
    return url.toString();
  }

  private databaseName(): string {
    try {
      return new URL(this.databaseUrl()).pathname.replace(/^\//, '') || 'joust';
    } catch {
      return 'joust';
    }
  }

  /** Same server, different database — used for the sanitize scratch copy and
   *  for the maintenance connection that creates and drops it. */
  private urlForDatabase(name: string): string {
    const url = new URL(this.databaseUrl());
    url.pathname = `/${name}`;
    return url.toString();
  }

  /** The migration this dump was taken at. The one field that decides whether a
   *  backup from elsewhere can be restored here at all. */
  private async currentMigration(): Promise<string | null> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<
        { migration_name: string }[]
      >(
        `SELECT migration_name FROM "_prisma_migrations"
         WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`,
      );
      return rows[0]?.migration_name ?? null;
    } catch {
      return null;
    }
  }

  private async pgDump(url: string, outFile: string): Promise<void> {
    // -Fc is already zlib-compressed, and restores selectively; --no-owner so a
    // dump taken as one role restores as another (the defense copy's DB user is
    // not necessarily this one).
    await run('pg_dump', ['-Fc', '--no-owner', '--no-acl', '-f', outFile, '-d', url], {
      maxBuffer: 1024 * 1024 * 16,
    });
  }

  private async pgRestore(url: string, inFile: string): Promise<void> {
    try {
      await run(
        'pg_restore',
        ['--clean', '--if-exists', '--no-owner', '--no-acl', '-d', url, inFile],
        { maxBuffer: 1024 * 1024 * 16 },
      );
    } catch (err: any) {
      // pg_restore exits non-zero on warnings it has already recovered from
      // (a DROP of something that was not there, most often). Only treat it as
      // a failure when it actually reports errors.
      const stderr: string = err?.stderr ?? '';
      if (!/\berror\b/i.test(stderr)) {
        this.logger.warn(`pg_restore reported warnings: ${stderr.trim().slice(0, 500)}`);
        return;
      }
      throw new BadRequestException(
        `Restore failed: ${stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400)}`,
      );
    }
  }

  private async psql(url: string, sql: string): Promise<string> {
    const { stdout } = await run('psql', ['-v', 'ON_ERROR_STOP=1', '-d', url, '-c', sql], {
      maxBuffer: 1024 * 1024 * 8,
    });
    return stdout;
  }

  // ─── Creating ───────────────────────────────────────────────────────────

  private slug(alias?: string | null): string {
    if (!alias) return '';
    const s = alias
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return s ? `-${s}` : '';
  }

  private stamp(d = new Date()): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return (
      `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
      `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    );
  }

  async create(opts: {
    alias?: string | null;
    description?: string | null;
    trigger: BackupTrigger;
    sanitized?: boolean;
  }): Promise<BackupListEntry> {
    const sanitized = !!opts.sanitized;
    const tmp = join(tmpdir(), `joust-dump-${randomBytes(6).toString('hex')}.pgc`);

    try {
      await this.pgDump(this.databaseUrl(), tmp);
      const payload = sanitized
        ? await this.sanitizedPayload(tmp)
        : await fs.readFile(tmp);

      const name = `joust-${this.stamp()}${this.slug(opts.alias)}.joustql`;
      const path = join(await this.directory(), name);

      // An alias means somebody meant to keep this one; pinning it by default
      // stops fourteen nightly runs from quietly deleting the snapshot that was
      // made for a defense.
      const manifest = await writeJoustql(path, payload, {
        createdAt: new Date().toISOString(),
        database: this.databaseName(),
        schemaMigration: await this.currentMigration(),
        trigger: opts.trigger,
        alias: opts.alias?.trim() || null,
        description: opts.description?.trim() || null,
        pinned: !!opts.alias?.trim(),
        sanitized,
        // A sanitized export holds nothing worth encrypting, and it is the copy
        // meant to be handed to someone else — a file needing a key is a bad
        // demo artefact.
        encrypt: !sanitized,
      });

      this.logger.log(
        `Backup created: ${name} (${manifest.payloadBytes} bytes, ${
          sanitized ? 'sanitized' : 'full'
        }, trigger=${opts.trigger})`,
      );
      await this.prune();
      const stat = await fs.stat(path);
      return { ...manifest, name, fileBytes: stat.size };
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  /**
   * Scrub in a scratch database rather than in place: `CREATE DATABASE …
   * TEMPLATE` is refused while the source has open connections, and the app is
   * always connected. Restoring into an empty scratch database has no such
   * problem, and at ~10MB the round trip takes seconds.
   */
  private async sanitizedPayload(dumpFile: string): Promise<Buffer> {
    const scratch = `joust_sanitize_${randomBytes(4).toString('hex')}`;
    const admin = this.urlForDatabase('postgres');
    const scratchUrl = this.urlForDatabase(scratch);
    const out = join(tmpdir(), `${scratch}.pgc`);

    await this.psql(admin, `CREATE DATABASE "${scratch}"`);
    try {
      await this.pgRestore(scratchUrl, dumpFile);
      await this.psql(scratchUrl, SANITIZE_SQL);

      // Never ship an export on the assumption that the scrub worked.
      const leaked = await this.psql(scratchUrl, SANITIZE_VERIFY_SQL);
      const count = Number(leaked.match(/\d+/)?.[0] ?? '0');
      if (count > 0) {
        throw new Error(
          `Sanitization left ${count} real address(es) in the export — refusing to write it.`,
        );
      }

      await this.pgDump(scratchUrl, out);
      return await fs.readFile(out);
    } finally {
      await fs.rm(out, { force: true });
      await this.psql(admin, `DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(
        (err) => this.logger.error(`Could not drop scratch database ${scratch}`, err),
      );
    }
  }

  /** The password every account shares in a sanitized copy, so the UI can say
   *  what to log in with. */
  get sanitizedPassword(): string {
    return SANITIZED_PASSWORD_PLAINTEXT;
  }

  /**
   * Exit after a restore so the container's restart policy brings the process
   * back with nothing stale in memory.
   *
   * The test is `process.pid === 1`, not "am I in Docker". Being containerised
   * is not enough: under `nest start --watch` the application is a CHILD of the
   * watcher, so exiting kills the HTTP server while the container stays happily
   * "Up" and nothing ever restarts it — the server is simply gone until someone
   * notices. That is exactly what happened the first time this was tested.
   *
   * When we are not PID 1, the in-memory state is cleared in place instead
   * (see `restore()`), and the caller is told no restart is coming so the UI
   * does not sit waiting for a reboot that will never happen.
   */
  scheduleRestart(): boolean {
    const supervised =
      process.pid === 1 &&
      (existsSync('/.dockerenv') || process.env.RUNNING_IN_DOCKER === 'true');
    if (!supervised) {
      this.logger.warn(
        'Restore finished. Not exiting: this process is not PID 1, so nothing would bring it back. In-memory caches were cleared instead.',
      );
      return false;
    }
    this.logger.warn('Restore finished. Restarting to clear in-memory state.');
    // Long enough for the HTTP response to be flushed to the browser.
    setTimeout(() => process.exit(0), 750).unref();
    return true;
  }

  // ─── Listing / labelling / deleting ─────────────────────────────────────

  async list(): Promise<BackupListEntry[]> {
    const dir = await this.directory();
    const files = (await fs.readdir(dir)).filter((f) => FILENAME.test(f));
    const out: BackupListEntry[] = [];
    for (const name of files) {
      try {
        const [manifest, stat] = await Promise.all([
          readManifest(join(dir, name)),
          fs.stat(join(dir, name)),
        ]);
        out.push({ ...manifest, name, fileBytes: stat.size });
      } catch (err) {
        // One unreadable file must not hide every other backup from the screen.
        this.logger.warn(`Skipping unreadable backup ${name}: ${(err as Error).message}`);
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async update(
    name: string,
    patch: { alias?: string | null; description?: string | null; pinned?: boolean },
  ): Promise<BackupListEntry> {
    const path = await this.resolveFile(name);
    const manifest = await rewriteManifest(path, patch);
    const stat = await fs.stat(path);
    return { ...manifest, name, fileBytes: stat.size };
  }

  async remove(name: string): Promise<void> {
    const path = await this.resolveFile(name);
    await fs.rm(path);
    this.logger.log(`Backup deleted: ${name}`);
  }

  async pathFor(name: string): Promise<string> {
    return this.resolveFile(name);
  }

  /**
   * Rolling deletion: keep the newest N, drop the rest — but never a pinned
   * one. Retention is about nightly noise, not about the snapshot somebody
   * deliberately labelled.
   */
  async prune(): Promise<number> {
    const keep = Math.max(1, Number((await this.settings.get('BACKUP_RETENTION')) ?? 14));
    const all = await this.list();
    const disposable = all.filter((b) => !b.pinned);
    const doomed = disposable.slice(keep);
    const dir = await this.directory();
    for (const b of doomed) {
      await fs.rm(join(dir, b.name), { force: true });
      this.logger.log(`Rolled off old backup: ${b.name}`);
    }
    return doomed.length;
  }

  // ─── Importing / restoring ──────────────────────────────────────────────

  /** Validate an uploaded file, then keep it as an ordinary entry. */
  async importFile(tempPath: string, originalName: string): Promise<BackupListEntry> {
    try {
      const { manifest } = await readPayload(tempPath);
      const name = `joust-${this.stamp()}${this.slug(
        manifest.alias ?? 'imported',
      )}.joustql`;
      const dest = join(await this.directory(), name);
      await fs.copyFile(tempPath, dest);
      await rewriteManifest(dest, {}); // normalises nothing, proves it re-reads
      const stat = await fs.stat(dest);
      this.logger.log(`Backup imported: ${originalName} -> ${name}`);
      return { ...manifest, name, fileBytes: stat.size };
    } catch (err) {
      if (err instanceof JoustqlError) {
        throw new BadRequestException({ message: err.message, code: err.code });
      }
      throw err;
    } finally {
      await fs.rm(tempPath, { force: true });
    }
  }

  async assertRestoreAllowed(): Promise<void> {
    if (!(await this.settings.getBoolean('BACKUP_ALLOW_RESTORE'))) {
      throw new ForbiddenException(
        'Restoring is disabled. Enable it in Admin → Dev Tools first — a restore overwrites the entire database.',
      );
    }
  }

  /**
   * Overwrite this database with the contents of a backup.
   *
   * A pre-restore backup is taken first and unconditionally: the single worst
   * outcome here is restoring the wrong file and having nothing to go back to.
   */
  async restore(name: string): Promise<{ replacedBy: string; safetyCopy: string | null }> {
    await this.assertRestoreAllowed();
    const path = await this.resolveFile(name);

    let manifest: JoustqlManifest;
    let payload: Buffer;
    try {
      ({ manifest, payload } = await readPayload(path));
    } catch (err) {
      if (err instanceof JoustqlError) {
        throw new BadRequestException({ message: err.message, code: err.code });
      }
      throw err;
    }

    const here = await this.currentMigration();
    if (manifest.schemaMigration && here && manifest.schemaMigration !== here) {
      throw new BadRequestException({
        code: 'SCHEMA_MISMATCH',
        message:
          `This backup is from schema "${manifest.schemaMigration}" but this server is at "${here}". ` +
          'Restoring it would leave the database and the application disagreeing about the schema.',
      });
    }

    let safety: string | null = null;
    if (manifest.trigger !== 'pre-restore') {
      const copy = await this.create({
        trigger: 'pre-restore',
        description: `Automatic safety copy taken before restoring ${name}`,
      });
      safety = copy.name;
    }

    const tmp = join(tmpdir(), `joust-restore-${randomBytes(6).toString('hex')}.pgc`);
    try {
      await fs.writeFile(tmp, payload);
      await this.prisma.$disconnect(); // an open pool holds locks --clean trips on
      await this.pgRestore(this.databaseUrl(), tmp);
      // Every cached value just became a value from a different database. This
      // matters even when the process is about to exit: if it is not PID 1 it
      // will not exit, and stale settings would outlive the restore.
      this.settings.clearCache();
      this.logger.warn(`Database restored from ${name} (safety copy: ${safety ?? 'none'})`);
      return { replacedBy: name, safetyCopy: safety };
    } finally {
      await fs.rm(tmp, { force: true });
      await this.prisma.$connect().catch(() => undefined);
    }
  }
}
