import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ParticipantStatus, TournamentStatus } from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';
import { ImagesService } from '../images/images.service';

const galleryInclude = { game: { select: { id: true, name: true } } } as const;

/**
 * Profile galleries (todo.md obj. 4.3): one image per game on a profile.
 *
 * Posting is earned, not granted: an account must have COMPLETED at least one
 * tournament as an active entrant — a tournament that reached COMPLETED where
 * the player was not forfeited (removed players have no participant row at all).
 * That was chosen over email verification, which nobody passes while two-factor
 * is off, and it keeps drive-by accounts from filling profiles with images.
 */
@Injectable()
export class GalleryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly images: ImagesService,
  ) {}

  async isEligible(userId: string): Promise<boolean> {
    const entry = await this.prisma.tournamentParticipant.findFirst({
      where: {
        userId,
        status: ParticipantStatus.ACTIVE,
        tournament: { status: TournamentStatus.COMPLETED },
        user: { isGuest: false },
      },
      select: { id: true },
    });
    return !!entry;
  }

  /** A profile's live images, for the public profile payload. */
  async publicGallery(userId: string) {
    const rows = await this.prisma.galleryImage.findMany({
      where: { userId, removedAt: null },
      orderBy: { updatedAt: 'desc' },
      include: galleryInclude,
    });
    return rows.map((r) => ({
      id: r.id,
      gameId: r.gameId,
      gameName: r.game.name,
      imageUrl: r.imageUrl,
      caption: r.caption,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /** The owner's view for Edit Profile: their images plus whether they may post. */
  async mine(userId: string) {
    return {
      eligible: await this.isEligible(userId),
      requirement: 'Finish at least one tournament (without being forfeited) to post to your gallery.',
      images: await this.publicGallery(userId),
    };
  }

  /** Put or replace the image for one game. */
  async upsert(userId: string, gameId: string, file: Express.Multer.File | undefined, caption?: string) {
    if (!(await this.isEligible(userId))) {
      throw new ForbiddenException({
        code: 'GALLERY_NOT_ELIGIBLE',
        message: 'Finish at least one tournament (without being forfeited) to post to your gallery.',
      });
    }
    const game = await this.prisma.game.findUnique({ where: { id: gameId }, select: { id: true, isBuiltin: true } });
    if (!game || game.isBuiltin) throw new NotFoundException('Game not found');

    const existing = await this.prisma.galleryImage.findFirst({ where: { userId, gameId, removedAt: null } });

    let imageUrl = existing?.imageUrl;
    if (file) {
      if (!file.mimetype?.startsWith('image/')) throw new BadRequestException('That file is not an image.');
      try {
        imageUrl = await this.images.processAndSave(file, 'gallery');
      } catch {
        throw new BadRequestException('That file could not be read as an image.');
      }
    }
    if (!imageUrl) throw new BadRequestException('Choose an image to upload.');

    const data = { imageUrl, caption: caption?.trim() || null };
    const saved = existing
      ? await this.prisma.galleryImage.update({ where: { id: existing.id }, data, include: galleryInclude })
      : await this.prisma.galleryImage.create({ data: { userId, gameId, ...data }, include: galleryInclude });

    if (existing && existing.imageUrl !== imageUrl) await this.images.deleteFile(existing.imageUrl);
    return saved;
  }

  /** The owner deleting their own image — immediate and permanent, unlike an
   *  admin removal, which is held 30 days in case it was a mistake. */
  async remove(userId: string, gameId: string) {
    const existing = await this.prisma.galleryImage.findFirst({ where: { userId, gameId, removedAt: null } });
    if (!existing) throw new NotFoundException('No image for that game.');
    await this.prisma.galleryImage.delete({ where: { id: existing.id } });
    await this.images.deleteFile(existing.imageUrl);
    return { message: 'Image deleted' };
  }
}
