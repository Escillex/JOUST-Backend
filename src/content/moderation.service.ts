import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditCategory, BuildStatus, NotificationType, Prisma, ReportStatus, Role } from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';
import { ImagesService } from '../images/images.service';
import { NotificationService } from '../notification/notification.service';
import { AuditService } from '../audit/audit.service';
import { checkTournamentAccess } from '../guards/tournament-access.util';
import type { JwtPayload } from '../guards/jwt-auth.guard';
import { BuildService } from './build.service';
import { ModerationRemoveDto, ModerationTargetDto, ReportDto } from './dto/content.dto';

/** How long an admin-removed item is kept, hidden, before it is purged. */
export const REMOVAL_HOLD_DAYS = 30;
const HOLD_MS = REMOVAL_HOLD_DAYS * 24 * 60 * 60 * 1000;

type TargetType = 'GALLERY_IMAGE' | 'TOURNAMENT_BUILD';
type Actor = JwtPayload & { id?: string; sub?: string; roles?: string[]; username?: string | null };
const actorId = (a: Actor) => a.id ?? a.sub!;
const nameOf = (u: { username: string | null; displayName: string | null } | null | undefined) =>
  u ? u.displayName || u.username || 'a user' : 'a user';

const personSelect = { id: true, username: true, displayName: true, slug: true } as const;

/**
 * Reports and removals for user content — gallery images and tournament
 * builds (todo.md obj. 4.3).
 *
 * Players REPORT; organizers REQUEST removal (the same report, flagged as staff
 * so it sorts first); only ADMINS remove. A removal hides the item at once and
 * keeps it for 30 days so a wrongful removal can be undone, then the hourly job
 * purges it. The owner is told what was removed and why.
 */
@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly images: ImagesService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
  ) {}

  private async load(type: TargetType, id: string) {
    if (type === 'GALLERY_IMAGE') {
      const g = await this.prisma.galleryImage.findUnique({
        where: { id },
        include: { user: { select: personSelect }, game: { select: { name: true } } },
      });
      return g ? { type, row: g, ownerId: g.userId, owner: g.user, label: `gallery image for ${g.game.name}` } : null;
    }
    const b = await this.prisma.tournamentBuild.findUnique({
      where: { id },
      include: {
        user: { select: personSelect },
        tournament: {
          select: { id: true, name: true, status: true, buildsRequired: true, buildVisibility: true, buildsLockAtStart: true },
        },
      },
    });
    return b
      ? { type, row: b, ownerId: b.userId, owner: b.user, label: `build for ${b.tournament.name}`, tournament: b.tournament }
      : null;
  }

  // ─── Reporting ──────────────────────────────────────────────────────────

  async report(reporter: Actor, dto: ReportDto) {
    const me = actorId(reporter);
    const target = await this.load(dto.targetType, dto.targetId);
    if (!target || target.row.removedAt) throw new NotFoundException('That item no longer exists.');
    if (target.ownerId === me) throw new ForbiddenException('You cannot report your own upload — delete it instead.');

    // You can only report what you can see: a build hidden from you by the
    // tournament's visibility setting is not yours to judge.
    if (dto.targetType === 'TOURNAMENT_BUILD' && 'tournament' in target && target.tournament) {
      const staff = (await checkTournamentAccess(this.prisma, target.tournament.id, reporter)) === 'ALLOWED';
      const b = target.row as { status: BuildStatus; removedAt: Date | null };
      if (!staff && !BuildService.visibleToPublic(target.tournament, b)) {
        throw new NotFoundException('That item no longer exists.');
      }
    }

    const roles = reporter.roles ?? [];
    const fromStaff = roles.includes(Role.ORGANIZER) || roles.includes(Role.ADMIN);
    try {
      await this.prisma.contentReport.create({
        data: {
          reporterId: me,
          reason: dto.reason,
          note: dto.note?.trim() || null,
          fromStaff,
          ...(dto.targetType === 'GALLERY_IMAGE'
            ? { galleryImageId: dto.targetId }
            : { tournamentBuildId: dto.targetId }),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({ code: 'ALREADY_REPORTED', message: 'You have already reported this.' });
      }
      throw err;
    }

    // A player's report is not an organizer action; a staff removal request is.
    if (fromStaff) {
      await this.audit.record({
        actor: reporter,
        category: AuditCategory.MODERATION,
        action: 'moderation.request_removal',
        summary: `Requested removal of ${nameOf(target.owner)}'s ${target.label} (${dto.reason.toLowerCase().replace(/_/g, ' ')})`,
        targetUserId: target.ownerId,
        targetName: nameOf(target.owner),
        ...('tournament' in target && target.tournament
          ? { tournamentId: target.tournament.id, tournamentName: target.tournament.name }
          : {}),
      });
    }
    return {
      message: fromStaff ? 'Removal requested. An admin will review it.' : 'Reported. An admin will review it.',
    };
  }

  // ─── The admin queue ────────────────────────────────────────────────────

  async openCount() {
    const [g, b] = await Promise.all([
      this.prisma.galleryImage.count({ where: { removedAt: null, reports: { some: { status: ReportStatus.OPEN } } } }),
      this.prisma.tournamentBuild.count({ where: { removedAt: null, reports: { some: { status: ReportStatus.OPEN } } } }),
    ]);
    return { open: g + b };
  }

  /** `open`: live items with open reports, staff requests and the most-reported
   *  first. `removed`: items still inside their 30-day hold, restorable. */
  async queue(view: 'open' | 'removed') {
    const reportInclude = {
      where: view === 'open' ? { status: ReportStatus.OPEN } : {},
      orderBy: { createdAt: 'asc' as const },
      include: { reporter: { select: personSelect } },
    };
    const where =
      view === 'open'
        ? { removedAt: null, reports: { some: { status: ReportStatus.OPEN } } }
        : { removedAt: { not: null } };

    const [gallery, builds] = await Promise.all([
      this.prisma.galleryImage.findMany({
        where,
        include: { user: { select: personSelect }, game: { select: { name: true } }, reports: reportInclude },
      }),
      this.prisma.tournamentBuild.findMany({
        where,
        include: { user: { select: personSelect }, tournament: { select: { id: true, name: true } }, reports: reportInclude },
      }),
    ]);

    const removerIds = [...gallery, ...builds].map((r) => r.removedById).filter(Boolean) as string[];
    const removers = removerIds.length
      ? new Map(
          (await this.prisma.user.findMany({ where: { id: { in: removerIds } }, select: personSelect })).map((u) => [u.id, nameOf(u)]),
        )
      : new Map<string, string>();

    const shape = (r: { reason: string; note: string | null; fromStaff: boolean; createdAt: Date; reporter: { username: string | null; displayName: string | null } }) => ({
      reason: r.reason,
      note: r.note,
      fromStaff: r.fromStaff,
      createdAt: r.createdAt.toISOString(),
      reporterName: nameOf(r.reporter),
    });
    const hold = (removedAt: Date | null) =>
      removedAt ? { removedAt: removedAt.toISOString(), purgeAt: new Date(removedAt.getTime() + HOLD_MS).toISOString() } : {};

    const items = [
      ...gallery.map((g) => ({
        targetType: 'GALLERY_IMAGE' as const,
        targetId: g.id,
        owner: { id: g.user.id, name: nameOf(g.user), slug: g.user.slug },
        context: { kind: 'game', name: g.game.name },
        preview: { kind: 'IMAGE', imageUrl: g.imageUrl, caption: g.caption },
        reports: g.reports.map(shape),
        removalReason: g.removalReason,
        removedByName: g.removedById ? removers.get(g.removedById) ?? null : null,
        ...hold(g.removedAt),
      })),
      ...builds.map((b) => ({
        targetType: 'TOURNAMENT_BUILD' as const,
        targetId: b.id,
        owner: { id: b.user.id, name: nameOf(b.user), slug: b.user.slug },
        context: { kind: 'tournament', id: b.tournament.id, name: b.tournament.name },
        preview: { kind: b.kind, imageUrl: b.imageUrl, text: b.text, url: b.url },
        reports: b.reports.map(shape),
        removalReason: b.removalReason,
        removedByName: b.removedById ? removers.get(b.removedById) ?? null : null,
        ...hold(b.removedAt),
      })),
    ];

    return items.sort((a, b) => {
      if (view === 'removed') return (b.removedAt ?? '').localeCompare(a.removedAt ?? '');
      const staff = (x: typeof a) => x.reports.some((r) => r.fromStaff);
      if (staff(a) !== staff(b)) return staff(a) ? -1 : 1;
      if (a.reports.length !== b.reports.length) return b.reports.length - a.reports.length;
      return (a.reports[0]?.createdAt ?? '').localeCompare(b.reports[0]?.createdAt ?? '');
    });
  }

  // ─── Admin actions ──────────────────────────────────────────────────────

  async remove(admin: Actor, dto: ModerationRemoveDto) {
    const target = await this.load(dto.targetType, dto.targetId);
    if (!target) throw new NotFoundException('That item no longer exists.');
    if (target.row.removedAt) throw new ConflictException('That item has already been removed.');

    const data = { removedAt: new Date(), removedById: actorId(admin), removalReason: dto.reason.trim() };
    const reports = dto.targetType === 'GALLERY_IMAGE' ? { galleryImageId: dto.targetId } : { tournamentBuildId: dto.targetId };
    await this.prisma.$transaction([
      dto.targetType === 'GALLERY_IMAGE'
        ? this.prisma.galleryImage.update({ where: { id: dto.targetId }, data })
        : this.prisma.tournamentBuild.update({ where: { id: dto.targetId }, data }),
      this.prisma.contentReport.updateMany({
        where: { ...reports, status: ReportStatus.OPEN },
        data: { status: ReportStatus.RESOLVED, resolvedById: actorId(admin), resolvedAt: new Date() },
      }),
    ]);

    await this.notifications.notify({
      userId: target.ownerId,
      type: NotificationType.CONTENT_REMOVED,
      title: `Your ${target.label} was removed`,
      body: dto.reason.trim(),
      link: dto.targetType === 'GALLERY_IMAGE' ? '/profile/edit' : `/tournaments/${'tournament' in target ? target.tournament?.id : ''}`,
    });
    return { message: `Removed. It can be restored for ${REMOVAL_HOLD_DAYS} days.` };
  }

  async dismiss(admin: Actor, dto: ModerationTargetDto) {
    const reports = dto.targetType === 'GALLERY_IMAGE' ? { galleryImageId: dto.targetId } : { tournamentBuildId: dto.targetId };
    const { count } = await this.prisma.contentReport.updateMany({
      where: { ...reports, status: ReportStatus.OPEN },
      data: { status: ReportStatus.DISMISSED, resolvedById: actorId(admin), resolvedAt: new Date() },
    });
    if (count === 0) throw new NotFoundException('There are no open reports on that item.');
    return { message: `Dismissed ${count} report(s).` };
  }

  /** Undo a removal inside the hold. Refused if the owner has since posted a
   *  replacement into the same slot — two live items would break the rule of
   *  one per game / one per entrant, and the newer upload wins. */
  async restore(dto: ModerationTargetDto) {
    const target = await this.load(dto.targetType, dto.targetId);
    if (!target || !target.row.removedAt) throw new NotFoundException('That item is not in the removed list.');
    const data = { removedAt: null, removedById: null, removalReason: null };
    try {
      if (dto.targetType === 'GALLERY_IMAGE') await this.prisma.galleryImage.update({ where: { id: dto.targetId }, data });
      else await this.prisma.tournamentBuild.update({ where: { id: dto.targetId }, data });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          code: 'SLOT_TAKEN',
          message: 'The owner has uploaded a replacement since, so this one cannot be restored alongside it.',
        });
      }
      throw err;
    }
    return { message: 'Restored.' };
  }

  /** Hourly: permanently delete anything whose 30-day hold has passed. */
  async purgeExpired(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - HOLD_MS);
    const [gallery, builds] = await Promise.all([
      this.prisma.galleryImage.findMany({ where: { removedAt: { lt: cutoff } }, select: { id: true, imageUrl: true } }),
      this.prisma.tournamentBuild.findMany({ where: { removedAt: { lt: cutoff } }, select: { id: true, imageUrl: true } }),
    ]);
    if (gallery.length) await this.prisma.galleryImage.deleteMany({ where: { id: { in: gallery.map((g) => g.id) } } });
    if (builds.length) await this.prisma.tournamentBuild.deleteMany({ where: { id: { in: builds.map((b) => b.id) } } });
    for (const f of [...gallery, ...builds]) if (f.imageUrl) await this.images.deleteFile(f.imageUrl);
    const n = gallery.length + builds.length;
    if (n) this.logger.log(`Purged ${n} removed item(s) past their ${REMOVAL_HOLD_DAYS}-day hold.`);
    return n;
  }
}
