import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { decryptSetting, encryptSetting } from './settings.crypto';
import {
  SETTINGS,
  SettingName,
  SettingSpec,
  EDITABLE_SETTINGS,
} from './settings.keys';

/**
 * Runtime configuration, resolved DB -> env -> default.
 *
 * Cached in-process because settings are read on every sign-in; a database round
 * trip per login for a value that changes monthly is waste. The cache is
 * invalidated on write, and the whole thing is per-process, which is fine for a
 * single-instance deployment and is the same assumption `DevService` already
 * makes with its static fields.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private cache = new Map<string, string | null>();

  constructor(private readonly prisma: PrismaService) {}

  private spec(name: SettingName): SettingSpec {
    return SETTINGS[name];
  }

  /** Resolved value, or null when nothing is configured anywhere. */
  async get(name: SettingName): Promise<string | null> {
    const spec = this.spec(name);
    if (this.cache.has(spec.key)) return this.cache.get(spec.key) ?? null;

    const row = await this.prisma.systemSetting.findUnique({
      where: { key: spec.key },
    });

    let value: string | null = null;
    if (row) {
      try {
        value = row.encrypted ? decryptSetting(row.value) : row.value;
      } catch (err) {
        // A secret that cannot be decrypted usually means the encryption key
        // changed. Falling back to env is better than throwing on every read,
        // but it must be loud — otherwise mail silently starts failing.
        this.logger.error(
          `Could not decrypt setting "${spec.key}" (has SETTINGS_ENCRYPTION_KEY changed?). Falling back to env.`,
          err as Error,
        );
      }
    }
    if (value === null || value === '') {
      value =
        (spec.env ? process.env[spec.env]?.trim() : undefined) ||
        spec.default ||
        null;
    }

    this.cache.set(spec.key, value);
    return value;
  }

  async getBoolean(name: SettingName): Promise<boolean> {
    const value = await this.get(name);
    return value === 'true' || value === '1';
  }

  /** Every editable setting, for the admin UI. Secrets are reported as
   *  configured-or-not and never returned. */
  async listForAdmin(): Promise<
    {
      key: string;
      name: SettingName;
      value: string | null;
      secret: boolean;
      configured: boolean;
    }[]
  > {
    const out: Awaited<ReturnType<SettingsService['listForAdmin']>> = [];
    for (const name of EDITABLE_SETTINGS) {
      const spec = this.spec(name);
      const value = await this.get(name);
      out.push({
        key: spec.key,
        name,
        value: spec.secret ? null : value,
        secret: !!spec.secret,
        configured: value !== null && value !== '',
      });
    }
    return out;
  }

  async set(
    name: SettingName,
    value: string,
    updatedById?: string,
  ): Promise<void> {
    const spec = this.spec(name);
    const stored = spec.secret ? encryptSetting(value) : value;
    await this.prisma.systemSetting.upsert({
      where: { key: spec.key },
      create: {
        key: spec.key,
        value: stored,
        encrypted: !!spec.secret,
        updatedById,
      },
      update: { value: stored, encrypted: !!spec.secret, updatedById },
    });
    this.cache.delete(spec.key);
    // Never log the value: this is the one place secrets pass through.
    this.logger.log(
      `Setting "${spec.key}" updated${updatedById ? ` by ${updatedById}` : ''}`,
    );
  }

  /** Clear a setting so it falls back to env/default again. */
  async clear(name: SettingName): Promise<void> {
    const spec = this.spec(name);
    await this.prisma.systemSetting
      .delete({ where: { key: spec.key } })
      .catch(() => undefined);
    this.cache.delete(spec.key);
  }

  /** Drop the cache — used after a bulk write, and by tests. */
  invalidate(): void {
    this.cache.clear();
  }
}
