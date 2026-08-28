import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationType, GameRequestStatus } from '@prisma/client';
import { CreateGameDto } from './dto/create-game.dto';
import { RequestGameDto } from './dto/request-game.dto';
import { ResolveRequestDto } from './dto/resolve-request.dto';

@Injectable()
export class GameService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationService,
  ) {}

  /** List all games — public, builtin ("General") first, then alphabetical. */
  async list() {
    return this.prisma.game.findMany({
      orderBy: [{ isBuiltin: 'desc' }, { name: 'asc' }],
      include: {
        createdBy: { select: { id: true, username: true } },
        _count: { select: { tournaments: true } },
      },
    });
  }

  /** Get a single game by ID — public. */
  async get(id: string) {
    const game = await this.prisma.game.findUnique({
      where: { id },
      include: {
        createdBy: { select: { id: true, username: true } },
        _count: { select: { tournaments: true } },
      },
    });
    if (!game) throw new NotFoundException('Game not found');
    return game;
  }

  /** Resolve the built-in "General" game — the required floor every tournament
   *  falls back to. Seeded on startup, so this should always find it; it throws
   *  loudly rather than silently returning null if the seed never ran. */
  async getGeneral() {
    const general = await this.prisma.game.findUnique({
      where: { name: 'General' },
    });
    if (!general)
      throw new NotFoundException(
        'The built-in "General" game is missing — run the database seed.',
      );
    return general;
  }

  /** Create a new game — ADMIN only. */
  async create(dto: CreateGameDto, userId: string) {
    const existing = await this.prisma.game.findFirst({
      where: {
        OR: [{ name: dto.name }, ...(dto.slug ? [{ slug: dto.slug }] : [])],
      },
    });
    if (existing)
      throw new BadRequestException('A game with that name or slug already exists');

    return this.prisma.game.create({
      data: {
        name: dto.name,
        slug: dto.slug ?? null,
        description: dto.description ?? null,
        iconUrl: dto.iconUrl ?? null,
        ...(dto.trackingMode && { trackingMode: dto.trackingMode }),
        defaultConfig: dto.defaultConfig ?? undefined,
        isBuiltin: false, // admins cannot mint builtins via the API
        createdById: userId,
      },
      include: { createdBy: { select: { id: true, username: true } } },
    });
  }

  /** Update a non-builtin game — ADMIN only. The built-in "General" is locked. */
  async update(id: string, dto: Partial<CreateGameDto>) {
    const game = await this.prisma.game.findUnique({ where: { id } });
    if (!game) throw new NotFoundException('Game not found');
    if (game.isBuiltin)
      throw new ForbiddenException('The built-in "General" game cannot be modified');

    const renaming = !!dto.name && dto.name !== game.name;
    if (renaming) {
      const conflict = await this.prisma.game.findUnique({
        where: { name: dto.name },
      });
      if (conflict)
        throw new BadRequestException('A game with that name already exists');
    }

    const data = {
      ...(dto.name && { name: dto.name }),
      ...(dto.slug !== undefined && { slug: dto.slug }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.iconUrl !== undefined && { iconUrl: dto.iconUrl }),
      ...(dto.trackingMode && { trackingMode: dto.trackingMode }),
      ...(dto.defaultConfig !== undefined && {
        defaultConfig: dto.defaultConfig,
      }),
    };
    const include = { createdBy: { select: { id: true, username: true } } };

    // F9. Per-game stats and the legacy format designation are keyed by the game's
    // NAME, so a rename would otherwise strand all prior history under the old name
    // and start a fresh, empty bucket. Migrate those rows to the new name in the
    // same transaction as the rename, so history follows the game. (Renaming to an
    // existing name is already blocked above, so the target name has no rows.)
    if (renaming) {
      const oldName = game.name;
      const newName = dto.name as string;
      return this.prisma.$transaction(async (tx) => {
        const updated = await tx.game.update({ where: { id }, data, include });
        await tx.userGameStats.updateMany({
          where: { gameName: oldName },
          data: { gameName: newName },
        });
        await tx.tournamentFormat.updateMany({
          where: { gameName: oldName },
          data: { gameName: newName },
        });
        return updated;
      });
    }

    return this.prisma.game.update({ where: { id }, data, include });
  }

  /** Delete a non-builtin game that no tournament uses — ADMIN only. Strict, like
   *  format deletion: reassign tournaments off it first (a tournament always has a
   *  game, so we never orphan one). "General" can never be deleted. */
  async delete(id: string) {
    const game = await this.prisma.game.findUnique({
      where: { id },
      include: { _count: { select: { tournaments: true } } },
    });
    if (!game) throw new NotFoundException('Game not found');
    if (game.isBuiltin)
      throw new ForbiddenException('The built-in "General" game cannot be deleted');
    if (game._count.tournaments > 0) {
      throw new BadRequestException(
        `Cannot delete: ${game._count.tournaments} tournament(s) are using this game. Reassign them first.`,
      );
    }

    await this.prisma.game.delete({ where: { id } });
    return { message: 'Game deleted successfully' };
  }

  /** An organizer requests a game the catalog lacks. Records a durable GameRequest
   *  (the admin queue) AND fires a GAME_REQUESTED notification to every admin. It
   *  creates no game — the tournament runs under "General" until an admin resolves
   *  the request (todo.md §5). */
  async request(
    dto: RequestGameDto,
    requester: { id?: string; username?: string | null },
  ) {
    const who = requester?.username ?? 'An organizer';
    await this.prisma.gameRequest.create({
      data: {
        name: dto.name,
        note: dto.note ?? null,
        tournamentId: dto.tournamentId ?? null,
        requestedById: requester?.id ?? null,
      },
    });
    await this.notifications.notifyAdmins({
      type: NotificationType.GAME_REQUESTED,
      title: `Game requested: "${dto.name}"`,
      body:
        `${who} requested a new game "${dto.name}".` +
        (dto.note ? ` Note: ${dto.note}` : '') +
        ' Create it and reassign the tournament if appropriate.',
      link: '/admin?tab=GAMES',
      tournamentId: dto.tournamentId,
    });
    return { message: 'Request sent to admins' };
  }

  /** The admin queue of game requests — pending first, newest first. Carries the
   *  originating tournament and requester so an admin can resolve in one place. */
  async listRequests(status?: GameRequestStatus) {
    return this.prisma.gameRequest.findMany({
      where: status ? { status } : undefined,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: {
        tournament: { select: { id: true, name: true, game: { select: { name: true } } } },
        requestedBy: { select: { id: true, username: true } },
      },
    });
  }

  /** Mark a request RESOLVED or DISMISSED — ADMIN only. Creating the game and
   *  reassigning the tournament are separate actions (POST /games, PATCH
   *  /tournaments/:id/game); this only closes the queue entry. */
  async resolveRequest(id: string, dto: ResolveRequestDto) {
    const existing = await this.prisma.gameRequest.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Request not found');
    return this.prisma.gameRequest.update({
      where: { id },
      data: { status: dto.status },
    });
  }
}
