import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BuildKind,
  BuildStatus,
  BuildVisibility,
  NotificationType,
  ParticipantStatus,
  TournamentStatus,
} from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';
import { ImagesService } from '../images/images.service';
import { NotificationService } from '../notification/notification.service';
import { checkTournamentAccess } from '../guards/tournament-access.util';
import type { JwtPayload } from '../guards/jwt-auth.guard';
import {
  BuildSettingsDto,
  ReviewBuildDto,
  SubmitBuildDto,
} from './dto/content.dto';

type Viewer = JwtPayload | null | undefined;
const viewerId = (v: Viewer) =>
  v
    ? ((v as { id?: string; sub?: string }).id ?? (v as { sub?: string }).sub)
    : undefined;

const personSelect = {
  id: true,
  username: true,
  displayName: true,
  slug: true,
  isGuest: true,
} as const;

interface TournamentBuildRules {
  id: string;
  status: TournamentStatus;
  buildsRequired: boolean;
  buildVisibility: BuildVisibility;
  buildsLockAtStart: boolean;
}

/**
 * Tournament builds (todo.md obj. 4.3): what a player brought, as an image, a
 * plain-text decklist or an https link. Game-agnostic on purpose — the reason
 * deck systems were scoped out was that every game needs its own schema.
 *
 * Two modes, per tournament:
 *   buildsRequired = false  optional; a build is shown without review.
 *   buildsRequired = true   every active entrant must submit; organizers approve
 *                           each one; the tournament cannot start until all are
 *                           approved (see assertReadyToStart).
 */
@Injectable()
export class BuildService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly images: ImagesService,
    private readonly notifications: NotificationService,
  ) {}

  private async rules(
    tournamentId: string,
  ): Promise<TournamentBuildRules & { name: string }> {
    const t = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      select: {
        id: true,
        name: true,
        status: true,
        buildsRequired: true,
        buildVisibility: true,
        buildsLockAtStart: true,
      },
    });
    if (!t) throw new NotFoundException('Tournament not found');
    return t;
  }

  /** Locked once the tournament is under way (if the tournament locks at
   *  start), and always once it is over — a finished event's builds are record. */
  private isLocked(t: TournamentBuildRules) {
    if (t.status === TournamentStatus.COMPLETED) return true;
    return t.buildsLockAtStart && t.status === TournamentStatus.ONGOING;
  }

  /**
   * Whether someone other than the owner and staff may see a build. Visibility
   * is the organizer's call; when builds are required, an unapproved build is
   * never public — organizer validation is the point of that mode.
   */
  static visibleToPublic(
    t: Pick<
      TournamentBuildRules,
      'status' | 'buildsRequired' | 'buildVisibility'
    >,
    build: { status: BuildStatus; removedAt: Date | null },
  ): boolean {
    if (build.removedAt) return false;
    if (t.buildsRequired && build.status !== BuildStatus.APPROVED) return false;
    switch (t.buildVisibility) {
      case BuildVisibility.PUBLIC:
        return true;
      case BuildVisibility.AFTER_COMPLETION:
        return t.status === TournamentStatus.COMPLETED;
      case BuildVisibility.STAFF_ONLY:
        return false;
    }
  }

  /** Everything the tournament page needs, filtered for whoever is looking. */
  async list(tournamentId: string, viewer: Viewer) {
    const t = await this.rules(tournamentId);
    const me = viewerId(viewer);
    const staff =
      (await checkTournamentAccess(this.prisma, tournamentId, viewer)) ===
      'ALLOWED';

    const rows = await this.prisma.tournamentBuild.findMany({
      where: { tournamentId, removedAt: null },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: personSelect } },
    });

    // Review bookkeeping (a rejection note especially) is between the player
    // and the staff; other viewers get the build itself.
    const visible = rows
      .filter(
        (b) => staff || b.userId === me || BuildService.visibleToPublic(t, b),
      )
      .map((b) =>
        staff || b.userId === me
          ? b
          : { ...b, reviewNote: null, reviewedById: null },
      );

    let entrants: { userId: string; name: string; status: string }[] = [];
    if (staff) {
      // Staff see who has not submitted at all — the part a review queue of
      // submitted builds cannot show them.
      const parts = await this.prisma.tournamentParticipant.findMany({
        where: { tournamentId, status: ParticipantStatus.ACTIVE },
        select: { userId: true, user: { select: personSelect } },
      });
      const byUser = new Map(rows.map((b) => [b.userId, b]));
      entrants = parts.map((p) => ({
        userId: p.userId,
        name: p.user.displayName || p.user.username || 'Player',
        // Guests cannot sign in, so they cannot submit — and are not required to.
        status:
          byUser.get(p.userId)?.status ??
          (p.user.isGuest ? 'GUEST' : 'MISSING'),
      }));
    }

    return {
      settings: {
        buildsRequired: t.buildsRequired,
        buildVisibility: t.buildVisibility,
        buildsLockAtStart: t.buildsLockAtStart,
        locked: this.isLocked(t),
      },
      canManage: staff,
      mine: rows.find((b) => b.userId === me) ?? null,
      builds: visible,
      ...(staff ? { entrants } : {}),
    };
  }

  /** Submit or replace the caller's build. */
  async submit(
    tournamentId: string,
    userId: string,
    dto: SubmitBuildDto,
    file?: Express.Multer.File,
  ) {
    const t = await this.rules(tournamentId);
    if (this.isLocked(t)) {
      throw new ForbiddenException({
        code: 'BUILDS_LOCKED',
        message: 'Builds are locked for this tournament.',
      });
    }
    const entry = await this.prisma.tournamentParticipant.findFirst({
      where: { tournamentId, userId },
      select: { status: true },
    });
    if (!entry || entry.status !== ParticipantStatus.ACTIVE) {
      throw new ForbiddenException(
        'Only an active entrant can submit a build for this tournament.',
      );
    }

    let imageUrl: string | null = null;
    if (dto.kind === BuildKind.IMAGE) {
      if (!file) throw new BadRequestException('Choose an image to upload.');
      if (!file.mimetype?.startsWith('image/'))
        throw new BadRequestException('That file is not an image.');
      try {
        imageUrl = await this.images.processAndSave(file, 'builds');
      } catch {
        throw new BadRequestException(
          'That file could not be read as an image.',
        );
      }
    }

    const data = {
      kind: dto.kind,
      imageUrl,
      text: dto.kind === BuildKind.TEXT ? dto.text!.trim() : null,
      url: dto.kind === BuildKind.LINK ? dto.url!.trim() : null,
      // Any change goes back to the queue: an approval covers what was
      // reviewed, not whatever the player swaps in afterwards.
      status: BuildStatus.PENDING,
      reviewedById: null,
      reviewedAt: null,
      reviewNote: null,
    };

    const existing = await this.prisma.tournamentBuild.findFirst({
      where: { tournamentId, userId, removedAt: null },
    });
    const saved = existing
      ? await this.prisma.tournamentBuild.update({
          where: { id: existing.id },
          data,
        })
      : await this.prisma.tournamentBuild.create({
          data: { tournamentId, userId, ...data },
        });

    if (existing?.imageUrl && existing.imageUrl !== imageUrl) {
      await this.images.deleteFile(existing.imageUrl);
    }
    return saved;
  }

  async withdraw(tournamentId: string, userId: string) {
    const t = await this.rules(tournamentId);
    if (this.isLocked(t)) {
      throw new ForbiddenException({
        code: 'BUILDS_LOCKED',
        message: 'Builds are locked for this tournament.',
      });
    }
    const existing = await this.prisma.tournamentBuild.findFirst({
      where: { tournamentId, userId, removedAt: null },
    });
    if (!existing)
      throw new NotFoundException('You have not submitted a build.');
    await this.prisma.tournamentBuild.delete({ where: { id: existing.id } });
    if (existing.imageUrl) await this.images.deleteFile(existing.imageUrl);
    return { message: 'Build withdrawn' };
  }

  /** An organizer's deck check. */
  async review(
    tournamentId: string,
    buildId: string,
    reviewerId: string,
    dto: ReviewBuildDto,
  ) {
    const t = await this.rules(tournamentId);
    const build = await this.prisma.tournamentBuild.findFirst({
      where: { id: buildId, tournamentId, removedAt: null },
    });
    if (!build) throw new NotFoundException('Build not found');

    const updated = await this.prisma.tournamentBuild.update({
      where: { id: buildId },
      data: {
        status: dto.decision,
        reviewedById: reviewerId,
        reviewedAt: new Date(),
        reviewNote:
          dto.decision === 'REJECTED'
            ? dto.note!.trim()
            : dto.note?.trim() || null,
      },
    });

    await this.notifications.notify({
      userId: build.userId,
      type: NotificationType.BUILD_REVIEWED,
      title:
        dto.decision === 'APPROVED'
          ? `Your build for ${t.name} was approved`
          : `Your build for ${t.name} was rejected`,
      body: dto.decision === 'REJECTED' ? dto.note : undefined,
      link: `/tournaments/${tournamentId}`,
      tournamentId,
    });
    return updated;
  }

  /** Mode and lock settle what the event IS, so they change only before it
   *  starts; visibility is presentation and may change at any time (e.g. to
   *  reveal builds after the event). */
  async updateSettings(tournamentId: string, dto: BuildSettingsDto) {
    const t = await this.rules(tournamentId);
    const started =
      t.status === TournamentStatus.ONGOING ||
      t.status === TournamentStatus.COMPLETED;
    if (
      started &&
      (dto.buildsRequired !== undefined || dto.buildsLockAtStart !== undefined)
    ) {
      throw new BadRequestException(
        'Mandatory builds and locking can only be changed before the tournament starts. Visibility can change any time.',
      );
    }
    return this.prisma.tournament.update({
      where: { id: tournamentId },
      data: dto,
      select: {
        buildsRequired: true,
        buildVisibility: true,
        buildsLockAtStart: true,
      },
    });
  }

  /** See assertBuildsReady. */
  assertReadyToStart(tournamentId: string) {
    return assertBuildsReady(this.prisma, tournamentId);
  }
}

/**
 * Called by startTournament when the tournament requires builds. Every active
 * account-holding entrant must hold an APPROVED build before the bracket is drawn — the refusal
 * names who is missing and who is waiting on review, so the organizer knows
 * exactly whom to chase (or forfeit). A plain function rather than a service
 * method so TournamentService can call it without a new constructor dependency.
 */
export async function assertBuildsReady(
  prisma: PrismaService,
  tournamentId: string,
) {
  // Guests are exempt: they have no account to submit from, so requiring one
  // would make any tournament with a walk-in guest impossible to start.
  const parts = await prisma.tournamentParticipant.findMany({
    where: {
      tournamentId,
      status: ParticipantStatus.ACTIVE,
      user: { isGuest: false },
    },
    select: {
      userId: true,
      user: { select: { username: true, displayName: true } },
    },
  });
  const builds = await prisma.tournamentBuild.findMany({
    where: { tournamentId, removedAt: null },
    select: { userId: true, status: true },
  });
  const status = new Map(builds.map((b) => [b.userId, b.status]));
  const name = (p: (typeof parts)[number]) =>
    p.user.displayName || p.user.username || 'Player';

  const missing = parts.filter((p) => !status.has(p.userId)).map(name);
  const pending = parts
    .filter(
      (p) =>
        status.has(p.userId) && status.get(p.userId) !== BuildStatus.APPROVED,
    )
    .map(name);
  if (missing.length || pending.length) {
    throw new ConflictException({
      code: 'BUILDS_INCOMPLETE',
      missing,
      pending,
      message:
        'This tournament requires approved builds from every entrant before it starts. ' +
        [
          missing.length ? `No build yet: ${missing.join(', ')}.` : '',
          pending.length ? `Not approved yet: ${pending.join(', ')}.` : '',
        ]
          .filter(Boolean)
          .join(' '),
    });
  }
}
