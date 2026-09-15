import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';
import {
  HOME_BLOCK_KEYS,
  HOME_DEFAULTS,
  HomeBlockContent,
  HomeBlockKey,
  HomeBlockView,
  isHomeBlockKey,
} from './home.defaults';
import { ReorderHomeBlocksDto, UpdateHomeBlockDto } from './home.dto';

const MAX_SLIDES = 12;
const MAX_STORE_BUTTONS = 6;

@Injectable()
export class HomeService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Reads ──────────────────────────────────────────────────────

  /**
   * The whole landing-page configuration, in render order. Blocks with no row
   * yet fall back to their defaults rather than disappearing: the home page is
   * public and must render on a database that predates this table.
   */
  async getConfig(): Promise<{ blocks: HomeBlockView[] }> {
    const rows = await this.prisma.homeBlock.findMany({
      orderBy: { order: 'asc' },
    });

    const byKey = new Map(rows.map((r) => [r.key, r]));
    const blocks: HomeBlockView[] = HOME_BLOCK_KEYS.map((key) => {
      const row = byKey.get(key);
      const fallback = HOME_DEFAULTS[key];
      if (!row) return { ...fallback };
      return {
        key,
        order: row.order,
        visible: row.visible,
        // A row whose content was never written (or was cleared) still needs
        // the default copy — an empty hero would otherwise ship a blank page.
        content: this.mergeWithDefault(key, row.content),
      };
    }).sort((a, b) => a.order - b.order);

    return { blocks };
  }

  private mergeWithDefault(
    key: HomeBlockKey,
    stored: Prisma.JsonValue | null,
  ): HomeBlockContent {
    const defaults = HOME_DEFAULTS[key].content;
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      return { ...defaults };
    }
    return { ...defaults, ...(stored as HomeBlockContent) };
  }

  // ─── Writes ─────────────────────────────────────────────────────

  async updateBlock(key: string, dto: UpdateHomeBlockDto) {
    if (!isHomeBlockKey(key)) {
      throw new BadRequestException({
        message: `Unknown home page section "${key}"`,
        code: 'UNKNOWN_HOME_BLOCK',
      });
    }

    const data: Prisma.HomeBlockUncheckedUpdateInput = {};
    if (dto.visible !== undefined) data.visible = dto.visible;
    if (dto.content !== undefined) {
      data.content = this.sanitizeContent(key, dto.content) as Prisma.InputJsonValue;
    }

    const fallback = HOME_DEFAULTS[key];
    const block = await this.prisma.homeBlock.upsert({
      where: { key },
      update: data,
      create: {
        key,
        order: fallback.order,
        visible: dto.visible ?? fallback.visible,
        content: (dto.content
          ? this.sanitizeContent(key, dto.content)
          : fallback.content) as Prisma.InputJsonValue,
      },
    });

    return {
      key: block.key,
      order: block.order,
      visible: block.visible,
      content: this.mergeWithDefault(key, block.content),
    };
  }

  /** New render order, given as the keys top to bottom. */
  async reorder(dto: ReorderHomeBlocksDto) {
    const unknown = dto.keys.filter((k) => !isHomeBlockKey(k));
    if (unknown.length) {
      throw new BadRequestException({
        message: `Unknown home page section(s): ${unknown.join(', ')}`,
        code: 'UNKNOWN_HOME_BLOCK',
      });
    }
    if (new Set(dto.keys).size !== dto.keys.length) {
      throw new BadRequestException({
        message: 'A section was listed twice in the new order',
        code: 'DUPLICATE_HOME_BLOCK',
      });
    }

    await this.prisma.$transaction(
      dto.keys.map((key, index) =>
        this.prisma.homeBlock.upsert({
          where: { key },
          update: { order: index },
          create: {
            key,
            order: index,
            visible: HOME_DEFAULTS[key as HomeBlockKey].visible,
            content: HOME_DEFAULTS[key as HomeBlockKey]
              .content as Prisma.InputJsonValue,
          },
        }),
      ),
    );

    return this.getConfig();
  }

  // ─── Content whitelisting ───────────────────────────────────────

  /**
   * Keeps only the fields each block actually renders, and caps their length.
   * An admin is trusted, but the landing page is the most public surface the
   * platform has: a stored `javascript:` href would be an XSS hole for every
   * visitor, and an unbounded string would be a way to break the layout for
   * everyone with one save.
   */
  private sanitizeContent(
    key: HomeBlockKey,
    content: Record<string, unknown>,
  ): HomeBlockContent {
    if (key === 'hero') return this.sanitizeHero(content);
    return { label: this.text(content.label, 40) || HOME_DEFAULTS[key].content.label as string };
  }

  private sanitizeHero(content: Record<string, unknown>): HomeBlockContent {
    const slidesIn = Array.isArray(content.slides) ? content.slides : [];
    const buttonsIn = Array.isArray(content.storeButtons)
      ? content.storeButtons
      : [];

    const slides = slidesIn
      .slice(0, MAX_SLIDES)
      .map((raw) => {
        const s = (raw ?? {}) as Record<string, unknown>;
        const image = this.url(s.image);
        if (!image) return null; // a slide with no picture is not a slide
        return {
          image,
          title: this.text(s.title, 80),
          photoDesc: this.text(s.photoDesc, 80),
        };
      })
      .filter((s): s is { image: string; title: string; photoDesc: string } => !!s);

    const storeButtons = buttonsIn
      .slice(0, MAX_STORE_BUTTONS)
      .map((raw) => {
        const b = (raw ?? {}) as Record<string, unknown>;
        const href = this.url(b.href);
        if (!href) return null; // a button that goes nowhere is not a button
        return {
          text: this.text(b.text, 40),
          href,
          color: this.color(b.color),
          iconUrl: this.url(b.iconUrl),
          iconScale: this.scale(b.iconScale),
        };
      })
      .filter((b): b is NonNullable<typeof b> => !!b);

    return {
      description: this.text(content.description, 400),
      slides,
      storeButtons,
    };
  }

  private text(value: unknown, max: number): string {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, max);
  }

  /**
   * A site-relative path or an absolute http(s) URL — nothing else. `//host`
   * is refused too: it is protocol-relative, which is an off-site link wearing
   * a relative path's clothes.
   */
  private url(value: unknown): string {
    if (typeof value !== 'string') return '';
    const v = value.trim();
    if (!v || v.length > 500) return '';
    if (v.startsWith('//')) return '';
    if (v.startsWith('/')) return v;
    if (/^https?:\/\/\S+$/i.test(v)) return v;
    return '';
  }

  /** Logo size inside a store button, clamped to what still fits the button. */
  private scale(value: unknown): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0) return 1;
    return Math.min(2, Math.max(0.5, Math.round(n * 100) / 100));
  }

  private color(value: unknown): string {
    if (typeof value !== 'string') return '#FFFFFF';
    const v = value.trim();
    return /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : '#FFFFFF';
  }
}
