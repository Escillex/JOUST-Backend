import { Injectable, Logger } from '@nestjs/common';
import { AuditCategory, Prisma } from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';
import type { AuditSpec } from './audit.decorator';

interface Actor { id?: string; sub?: string; username?: string | null; roles?: string[] }

/** Names resolved before the handler runs. */
export interface Prepared {
  actorName: string;
  tournamentId: string | null;
  tournamentName: string | null;
  targetUserId: string | null;
  targetName: string | null;
  subjectName: string | null;
  match?: { round: number; p1: string; p2: string };
}

const pickFrom = (body: unknown, keys: string[] = []) => {
  const out: Record<string, unknown> = {};
  if (body && typeof body === 'object') {
    for (const k of keys) if (k in (body as object)) out[k] = (body as Record<string, unknown>)[k];
  }
  return out;
};

/**
 * The audit log's only writer, like NotificationService is for notifications:
 * best-effort by contract. A failure to record is logged and swallowed — an
 * audit write must never be the reason an organizer's action failed.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  private nameOf(u: { username: string | null; displayName: string | null } | null) {
    return u ? u.displayName || u.username || 'Unknown user' : null;
  }

  /** Resolve names BEFORE the action — a deleted tournament or user can no
   *  longer be looked up afterwards. Never throws. */
  async prepare(spec: AuditSpec, actor: Actor, params: Record<string, string>, body: unknown): Promise<Prepared> {
    const out: Prepared = {
      actorName: actor.username || 'Unknown user',
      tournamentId: null,
      tournamentName: null,
      targetUserId: null,
      targetName: null,
      subjectName: null,
    };
    try {
      const actorId = actor.id || actor.sub;
      if (actorId) {
        const u = await this.prisma.user.findUnique({
          where: { id: actorId },
          select: { username: true, displayName: true },
        });
        out.actorName = this.nameOf(u) ?? out.actorName;
      }

      const src = spec.tournament;
      if (src && 'param' in src) out.tournamentId = params[src.param] ?? null;
      if (src && 'body' in src) out.tournamentId = (pickFrom(body, [src.body])[src.body] as string) ?? null;
      if (src && 'matchParam' in src && params[src.matchParam]) {
        const m = await this.prisma.match.findUnique({
          where: { id: params[src.matchParam] },
          select: {
            p1Name: true,
            p2Name: true,
            player1: { select: { username: true, displayName: true } },
            player2: { select: { username: true, displayName: true } },
            round: { select: { roundNumber: true, tournamentId: true } },
          },
        });
        if (m) {
          out.tournamentId = m.round.tournamentId;
          out.match = {
            round: m.round.roundNumber,
            p1: this.nameOf(m.player1) ?? m.p1Name ?? 'TBD',
            p2: this.nameOf(m.player2) ?? m.p2Name ?? 'TBD',
          };
        }
      }
      if (src && 'invitationParam' in src && params[src.invitationParam]) {
        const inv = await this.prisma.tournamentOrganizer.findUnique({
          where: { id: params[src.invitationParam] },
          select: { tournamentId: true },
        });
        out.tournamentId = inv?.tournamentId ?? null;
      }
      if (out.tournamentId) {
        const t = await this.prisma.tournament.findUnique({
          where: { id: out.tournamentId },
          select: { name: true },
        });
        out.tournamentName = t?.name ?? null;
      }

      const tu = spec.targetUser;
      const targetId = tu
        ? 'param' in tu
          ? params[tu.param]
          : (pickFrom(body, [tu.body])[tu.body] as string | undefined)
        : undefined;
      if (targetId) {
        out.targetUserId = targetId;
        const u = await this.prisma.user.findUnique({
          where: { id: targetId },
          select: { username: true, displayName: true },
        });
        out.targetName = this.nameOf(u);
      }

      const sub = spec.subject;
      const subjectId = sub
        ? 'param' in sub
          ? params[sub.param]
          : (pickFrom(body, [sub.body])[sub.body] as string | undefined)
        : undefined;
      if (sub && subjectId) out.subjectName = await this.subjectName(sub.model, subjectId);
    } catch (err) {
      this.logger.warn(`Audit prepare failed for ${spec.action}: ${String(err)}`);
    }
    return out;
  }

  private async subjectName(model: import('./audit.decorator').SubjectModel, id: string) {
    switch (model) {
      case 'game':
        return (await this.prisma.game.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
      case 'award':
        return (await this.prisma.award.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
      case 'tournamentFormat':
        return (await this.prisma.tournamentFormat.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
      case 'storeProduct':
        return (await this.prisma.storeProduct.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
      case 'userAward':
        return (
          await this.prisma.userAward.findUnique({ where: { id }, select: { award: { select: { name: true } } } })
        )?.award.name ?? null;
    }
  }

  /** Write the entry after the action succeeded. Never throws. */
  async commit(
    spec: AuditSpec,
    actor: Actor,
    prepared: Prepared,
    params: Record<string, string>,
    body: unknown,
    result: unknown,
  ): Promise<void> {
    try {
      let { tournamentId, tournamentName } = prepared;
      // Created by this very request: only the response knows its id.
      if (spec.tournament && 'result' in spec.tournament && result && typeof result === 'object') {
        tournamentId = ((result as Record<string, unknown>)[spec.tournament.result] as string) ?? null;
        tournamentName = ((result as Record<string, unknown>).name as string) ?? tournamentName;
      }
      const raw = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
      const picked = spec.pickFn ? spec.pickFn(raw) : pickFrom(body, spec.pick);
      const summary = spec.describe({
        t: tournamentName ? `"${tournamentName}"` : 'a tournament',
        target: prepared.targetName ?? 'a user',
        body: picked,
        params,
        fields: Object.keys(raw),
        subject: prepared.subjectName ?? 'an item',
        self: !!prepared.targetUserId && prepared.targetUserId === (actor.id || actor.sub),
        result,
        match: prepared.match,
      });

      await this.prisma.auditLog.create({
        data: {
          actorId: actor.id || actor.sub || null,
          actorName: prepared.actorName,
          actorRoles: actor.roles ?? [],
          category: spec.category,
          action: spec.action,
          summary: summary.slice(0, 500),
          tournamentId,
          tournamentName,
          targetUserId: prepared.targetUserId,
          targetName: prepared.targetName,
          metadata: Object.keys(picked).length
            ? (picked as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        },
      });
    } catch (err) {
      this.logger.warn(`Audit write failed for ${spec.action}: ${String(err)}`);
    }
  }

  /** The admin dashboard's read. Newest first, keyset-paged on (createdAt, id)
   *  so a busy log does not slow down as it grows. */
  async list(q: {
    category?: AuditCategory;
    search?: string;
    tournamentId?: string;
    actorId?: string;
    cursor?: string;
    limit?: number;
  }) {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const where: Prisma.AuditLogWhereInput = {
      ...(q.category ? { category: q.category } : {}),
      ...(q.tournamentId ? { tournamentId: q.tournamentId } : {}),
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.search
        ? {
            OR: [
              { summary: { contains: q.search, mode: 'insensitive' } },
              { actorName: { contains: q.search, mode: 'insensitive' } },
              { tournamentName: { contains: q.search, mode: 'insensitive' } },
              { targetName: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const more = rows.length > limit;
    const entries = more ? rows.slice(0, limit) : rows;
    return { entries, nextCursor: more ? entries[entries.length - 1].id : null };
  }
}
