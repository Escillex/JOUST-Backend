import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { CreateTournamentFormatDto } from './dto/create-format.dto';
import { Role } from '@prisma/client';

@Injectable()
export class TournamentFormatService {
  constructor(private prisma: PrismaService) {}

  /** List all formats — public, ordered builtin first */
  async list() {
    return this.prisma.tournamentFormat.findMany({
      orderBy: [{ isBuiltin: 'desc' }, { createdAt: 'asc' }],
      include: {
        createdBy: { select: { id: true, username: true } },
        _count: { select: { tournaments: true } },
      },
    });
  }

  /** Get a single format by ID */
  async get(id: string) {
    const fmt = await this.prisma.tournamentFormat.findUnique({
      where: { id },
      include: {
        createdBy: { select: { id: true, username: true } },
        _count: { select: { tournaments: true } },
      },
    });
    if (!fmt) throw new NotFoundException('Format not found');
    return fmt;
  }

  /** Create a new named format — ADMIN only */
  async create(dto: CreateTournamentFormatDto, userId: string) {
    const existing = await this.prisma.tournamentFormat.findUnique({
      where: { name: dto.name },
    });
    if (existing) throw new BadRequestException('A format with that name already exists');

    return this.prisma.tournamentFormat.create({
      data: {
        name: dto.name,
        description: dto.description ?? null,
        gameName: dto.gameName ?? null,
        system: dto.system,
        config: dto.config,
        isBuiltin: false, // admins cannot set isBuiltin via API
        createdById: userId,
      },
      include: {
        createdBy: { select: { id: true, username: true } },
      },
    });
  }

  /** Update a non-builtin format — ADMIN only */
  async update(id: string, dto: Partial<CreateTournamentFormatDto>, userRoles: Role[]) {
    const fmt = await this.prisma.tournamentFormat.findUnique({ where: { id } });
    if (!fmt) throw new NotFoundException('Format not found');
    if (fmt.isBuiltin) throw new ForbiddenException('Built-in formats cannot be modified');

    // Check for name collision if renaming
    if (dto.name && dto.name !== fmt.name) {
      const conflict = await this.prisma.tournamentFormat.findUnique({ where: { name: dto.name } });
      if (conflict) throw new BadRequestException('A format with that name already exists');
    }

    return this.prisma.tournamentFormat.update({
      where: { id },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.gameName !== undefined && { gameName: dto.gameName }),
        ...(dto.system && { system: dto.system }),
        ...(dto.config && { config: dto.config }),
      },
      include: {
        createdBy: { select: { id: true, username: true } },
      },
    });
  }

  /** Delete a non-builtin format that has no active tournaments — ADMIN only */
  async delete(id: string) {
    const fmt = await this.prisma.tournamentFormat.findUnique({
      where: { id },
      include: { _count: { select: { tournaments: true } } },
    });
    if (!fmt) throw new NotFoundException('Format not found');
    if (fmt.isBuiltin) throw new ForbiddenException('Built-in formats cannot be deleted');
    if (fmt._count.tournaments > 0) {
      throw new BadRequestException(
        `Cannot delete: ${fmt._count.tournaments} tournament(s) are using this format`,
      );
    }

    await this.prisma.tournamentFormat.delete({ where: { id } });
    return { message: 'Format deleted successfully' };
  }
}
