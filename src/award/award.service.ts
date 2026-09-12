import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AwardKind, NotificationType } from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';
import { ImagesService } from '../images/images.service';
import { NotificationService } from '../notification/notification.service';
import {
  CreateAwardDto,
  GrantAwardDto,
  ShowcaseDto,
  UpdateAwardDto,
} from './dto/award.dto';

/** What a profile shows for one grant. Who gave it is deliberately absent —
 *  that is admin bookkeeping, visible only in the admin grant view. */
export const PUBLIC_AWARD_SELECT = {
  id: true,
  awardId: true,
  awardedAt: true,
  note: true,
  pinSlot: true,
  displayed: true,
  award: {
    select: { name: true, description: true, kind: true, imageUrl: true },
  },
} as const;

type PublicAwardRow = {
  id: string;
  awardId: string;
  awardedAt: Date;
  note: string | null;
  pinSlot: number | null;
  displayed: boolean;
  award: {
    name: string;
    description: string | null;
    kind: AwardKind;
    imageUrl: string;
  };
};

/** Flattened for the frontend, which renders kind/name/image beside the
 *  grant's own date, note and showcase position. */
export function toPublicAward(row: PublicAwardRow) {
  return {
    id: row.id,
    awardId: row.awardId,
    kind: row.award.kind,
    name: row.award.name,
    description: row.award.description,
    imageUrl: row.award.imageUrl,
    awardedAt: row.awardedAt.toISOString(),
    note: row.note,
    pinSlot: row.pinSlot,
    displayed: row.displayed,
  };
}

const MAX_PINS = 3;

@Injectable()
export class AwardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly images: ImagesService,
    private readonly notifications: NotificationService,
  ) {}

  // ─── Catalog ────────────────────────────────────────────────────────────

  listCatalog(includeArchived: boolean) {
    return this.prisma.award.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }],
      include: { _count: { select: { grants: true } } },
    });
  }

  private folderFor(kind: AwardKind) {
    return kind === AwardKind.MEDAL ? 'medals' : 'plaques';
  }

  /** sharp throws on anything that is not an image; report that as the
   *  uploader's mistake rather than a 500. */
  private async saveArt(file: Express.Multer.File | undefined, kind: AwardKind) {
    if (!file) throw new BadRequestException('Artwork is required.');
    if (!file.mimetype?.startsWith('image/')) {
      throw new BadRequestException('The artwork must be an image (PNG or WebP recommended).');
    }
    try {
      return await this.images.processAndSave(file, this.folderFor(kind));
    } catch {
      throw new BadRequestException('That file could not be read as an image.');
    }
  }

  async create(dto: CreateAwardDto, file: Express.Multer.File | undefined, adminId: string) {
    const imageUrl = await this.saveArt(file, dto.kind);
    return this.prisma.award.create({
      data: {
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        kind: dto.kind,
        imageUrl,
        createdById: adminId,
      },
    });
  }

  private async findAward(id: string) {
    const award = await this.prisma.award.findUnique({ where: { id } });
    if (!award) throw new NotFoundException('Award not found.');
    return award;
  }

  async update(id: string, dto: UpdateAwardDto) {
    await this.findAward(id);
    return this.prisma.award.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description.trim() || null }
          : {}),
        ...(dto.archived !== undefined
          ? { archivedAt: dto.archived ? new Date() : null }
          : {}),
      },
    });
  }

  /** Save the new file and commit the row before deleting the old file — the
   *  same ordering ImagesService uses for avatars, so a failure midway leaves
   *  an orphaned file rather than a row pointing at nothing. */
  async replaceImage(id: string, file: Express.Multer.File | undefined) {
    const award = await this.findAward(id);
    const imageUrl = await this.saveArt(file, award.kind);
    const updated = await this.prisma.award.update({
      where: { id },
      data: { imageUrl },
    });
    if (award.imageUrl !== imageUrl) await this.images.deleteFile(award.imageUrl);
    return updated;
  }

  /** Only an award nobody holds can be deleted; the relation is RESTRICT, and
   *  this turns the would-be foreign-key error into an answer. */
  async remove(id: string) {
    const award = await this.findAward(id);
    const count = await this.prisma.userAward.count({ where: { awardId: id } });
    if (count > 0) {
      throw new ConflictException({
        code: 'AWARD_IN_USE',
        count,
        message: `${count} ${count === 1 ? 'person holds' : 'people hold'} this award. Archive it instead — it stops being given, and stays on their profiles.`,
      });
    }
    await this.prisma.award.delete({ where: { id } });
    await this.images.deleteFile(award.imageUrl);
    return { message: 'Award deleted' };
  }

  // ─── Grants ─────────────────────────────────────────────────────────────

  /** Admin view of one person's awards — includes who gave each. */
  async grantsFor(userId: string) {
    const rows = await this.prisma.userAward.findMany({
      where: { userId },
      orderBy: { awardedAt: 'desc' },
      select: {
        ...PUBLIC_AWARD_SELECT,
        awardedBy: { select: { id: true, username: true, displayName: true } },
      },
    });
    return rows.map((r) => ({ ...toPublicAward(r), awardedBy: r.awardedBy }));
  }

  async grant(userId: string, dto: GrantAwardDto, adminId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, isGuest: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    if (user.isGuest) {
      // Guests are purged by CleanGuestsJob; an award given to one would vanish.
      throw new BadRequestException({
        code: 'GUEST_CANNOT_RECEIVE_AWARDS',
        message: 'Guests cannot receive awards — convert them to a full account first.',
      });
    }

    const award = await this.findAward(dto.awardId);
    if (award.archivedAt) {
      throw new BadRequestException({
        code: 'AWARD_ARCHIVED',
        message: 'That award is archived and can no longer be given.',
      });
    }

    const row = await this.prisma.userAward.create({
      data: {
        userId,
        awardId: award.id,
        awardedById: adminId,
        note: dto.note?.trim() || null,
      },
      select: PUBLIC_AWARD_SELECT,
    });

    // Best-effort by contract: NotificationService never throws, so a failed
    // notification cannot undo the award.
    await this.notifications.notify({
      userId,
      type: NotificationType.AWARD_RECEIVED,
      title: `You received the ${award.name} ${award.kind === AwardKind.MEDAL ? 'medal' : 'plaque'}`,
      body: dto.note?.trim() || award.description || undefined,
      link: '/profile/edit',
    });

    return toPublicAward(row);
  }

  /**
   * Revoke one grant.
   *
   * With repeats, the showcase pins a *medal*, carried by one of its grants. If
   * that particular grant is revoked while the person still holds another of
   * the same award, the medal must stay where they put it — so its pin slot
   * (or plaque display) moves to a remaining grant instead of vanishing.
   * Delete first, then move: the unique (userId, pinSlot) index would reject
   * two grants holding the slot at once.
   */
  async revoke(userId: string, grantId: string) {
    const row = await this.prisma.userAward.findUnique({ where: { id: grantId } });
    if (!row || row.userId !== userId) throw new NotFoundException('Grant not found.');

    const heir =
      row.pinSlot || row.displayed
        ? await this.prisma.userAward.findFirst({
            where: { userId, awardId: row.awardId, id: { not: grantId } },
            orderBy: { awardedAt: 'desc' },
          })
        : null;

    await this.prisma.$transaction([
      this.prisma.userAward.delete({ where: { id: grantId } }),
      ...(heir
        ? [
            this.prisma.userAward.update({
              where: { id: heir.id },
              data: { pinSlot: row.pinSlot, displayed: row.displayed },
            }),
          ]
        : []),
    ]);
    return { message: 'Award revoked' };
  }

  // ─── Showcase ───────────────────────────────────────────────────────────

  /**
   * Replace the caller's showcase wholesale: which medals are pinned, in slot
   * order, and which plaque is shown under their name.
   *
   * Everything the database cannot check across the two tables is checked
   * here: the grants must be the caller's own, pins must be medals, the
   * displayed one must be a plaque, and one medal may not fill two slots.
   */
  async setShowcase(userId: string, dto: ShowcaseDto) {
    const pins = dto.pinnedMedals ?? [];
    if (pins.length > MAX_PINS) {
      throw new BadRequestException(`At most ${MAX_PINS} medals can be pinned.`);
    }
    if (new Set(pins).size !== pins.length) {
      throw new BadRequestException('The same grant cannot fill two slots.');
    }

    const wanted = [...pins, ...(dto.plaque ? [dto.plaque] : [])];
    const owned = await this.prisma.userAward.findMany({
      where: { id: { in: wanted }, userId },
      select: { id: true, awardId: true, award: { select: { kind: true } } },
    });
    const byId = new Map(owned.map((g) => [g.id, g]));

    for (const id of wanted) {
      if (!byId.has(id)) {
        // Deliberately the same answer whether the grant does not exist or
        // belongs to someone else.
        throw new BadRequestException('One of those awards is not yours.');
      }
    }
    const pinnedAwards = pins.map((id) => byId.get(id)!);
    if (pinnedAwards.some((g) => g.award.kind !== AwardKind.MEDAL)) {
      throw new BadRequestException('Only medals can be pinned.');
    }
    if (new Set(pinnedAwards.map((g) => g.awardId)).size !== pinnedAwards.length) {
      // "Champion" x3 is shown as one medal with a x3 badge, not three slots.
      throw new BadRequestException('The same medal cannot be pinned twice.');
    }
    if (dto.plaque && byId.get(dto.plaque)!.award.kind !== AwardKind.PLAQUE) {
      throw new BadRequestException('Only a plaque can be shown under your name.');
    }

    // Clear first, then set, in one transaction: the unique (userId, pinSlot)
    // index and the one-displayed-plaque partial index never see an
    // intermediate state with two claimants.
    await this.prisma.$transaction([
      this.prisma.userAward.updateMany({
        where: { userId },
        data: { pinSlot: null, displayed: false },
      }),
      ...pins.map((id, i) =>
        this.prisma.userAward.update({
          where: { id },
          data: { pinSlot: i + 1 },
        }),
      ),
      ...(dto.plaque
        ? [
            this.prisma.userAward.update({
              where: { id: dto.plaque },
              data: { displayed: true },
            }),
          ]
        : []),
    ]);

    const rows = await this.prisma.userAward.findMany({
      where: { userId },
      orderBy: { awardedAt: 'desc' },
      select: PUBLIC_AWARD_SELECT,
    });
    return rows.map(toPublicAward);
  }
}
