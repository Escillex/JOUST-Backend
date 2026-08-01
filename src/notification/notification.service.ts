import { Injectable, Logger } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';
import { RealtimeGateway } from 'src/realtime/realtime.gateway';

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
  tournamentId?: string;
}

/** The only writer of notifications. Callers state what happened; this decides
 *  who is eligible to hear about it and how it is delivered. */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger('NotificationService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** Writes one notification and pushes it to that user. Never throws: a failed
   *  notification must not fail the action that triggered it, so problems are
   *  logged and swallowed. */
  async notify(input: NotifyInput): Promise<void> {
    try {
      const row = await this.prisma.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          title: input.title,
          body: input.body,
          link: input.link,
          tournamentId: input.tournamentId,
        },
      });
      this.realtime.emitNotification(input.userId, {
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        link: row.link,
        createdAt: row.createdAt,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to write notification for ${input.userId}: ${String(error)}`,
      );
    }
  }

  /** Fan-out to several people at once. Guests are filtered here, in one query,
   *  rather than at every call site: they have no login to return to. */
  async notifyMany(
    userIds: string[],
    input: Omit<NotifyInput, 'userId'>,
  ): Promise<void> {
    if (userIds.length === 0) return;
    try {
      const eligible = await this.prisma.user.findMany({
        where: { id: { in: userIds }, isGuest: false },
        select: { id: true },
      });
      for (const user of eligible) {
        await this.notify({ ...input, userId: user.id });
      }
    } catch (error) {
      this.logger.warn(`Failed to fan out notifications: ${String(error)}`);
    }
  }

  /** The caller's own inbox. Cursor-paginated rather than offset-paginated, so a
   *  notification arriving mid-scroll cannot duplicate or skip a row. */
  async list(
    userId: string,
    opts: { unreadOnly?: boolean; take?: number; cursor?: string },
  ) {
    const take = Math.min(Math.max(opts.take ?? 20, 1), 50);
    const items = await this.prisma.notification.findMany({
      where: { userId, ...(opts.unreadOnly ? { read: false } : {}) },
      orderBy: { createdAt: 'desc' },
      // One extra row is fetched purely to learn whether another page exists.
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > take;
    const page = hasMore ? items.slice(0, take) : items;
    const unreadCount = await this.prisma.notification.count({
      where: { userId, read: false },
    });

    return {
      items: page,
      unreadCount,
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /** Scoped by userId as well as id, so one user can never mark another's row
   *  read. A miss is silent - the row either was not theirs or does not exist,
   *  and the client has nothing useful to do with the difference. */
  async markRead(userId: string, id: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { read: true },
    });
  }

  async markAllRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
  }
}
