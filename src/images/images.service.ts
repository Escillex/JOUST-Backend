import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class ImagesService {
  private readonly uploadRoot = path.join(process.cwd(), '..', 'images');

  constructor(private prisma: PrismaService) {
    // Ensure upload directories exist on startup
    const subdirs = ['avatars', 'banners', 'assets'];
    subdirs.forEach((sub) => {
      const dir = path.join(this.uploadRoot, sub);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  async processAndSave(
    file: Express.Multer.File,
    subdir: 'avatars' | 'banners' | 'assets',
  ): Promise<string> {
    const id = uuidv4();
    const fileName = `${id}.webp`;
    const outPath = path.join(this.uploadRoot, subdir, fileName);

    let sharpInstance = sharp(file.buffer);

    // Context-aware resizing
    if (subdir === 'avatars') {
      sharpInstance = sharpInstance.resize(400, 400, { fit: 'cover' });
    } else if (subdir === 'banners') {
      sharpInstance = sharpInstance.resize(1200, null, {
        withoutEnlargement: true,
      });
    } else if (subdir === 'assets') {
      sharpInstance = sharpInstance.resize(1920, null, {
        withoutEnlargement: true,
      });
    }

    await sharpInstance.webp({ quality: 80 }).toFile(outPath);

    return `/uploads/${subdir}/${fileName}`;
  }

  async deleteFile(urlPath: string): Promise<void> {
    if (!urlPath) return;
    // urlPath is /uploads/xxx/yyy.webp → map to __dirname/uploads/xxx/yyy.webp
    const relativePath = urlPath.startsWith('/uploads/')
      ? urlPath.replace('/uploads/', '')
      : urlPath;
    const absolutePath = path.join(this.uploadRoot, relativePath);

    if (fs.existsSync(absolutePath)) {
      try {
        fs.unlinkSync(absolutePath);
      } catch (err) {
        console.error(`Failed to delete file: ${absolutePath}`, err);
      }
    }
  }

  // ─── USER AVATAR ───────────────────────────────────────────────

  async updateAvatar(userId: string, file: Express.Multer.File) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    // Write the replacement before removing what it replaces. Deleting first
    // means a failure in processAndSave (unsupported format, sharp error, full
    // disk) leaves the record pointing at a file that no longer exists, with
    // nothing to fall back to.
    const newUrl = await this.processAndSave(file, 'avatars');
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: newUrl },
      select: { id: true, avatarUrl: true },
    });

    if (user.avatarUrl && user.avatarUrl !== newUrl) {
      await this.deleteFile(user.avatarUrl);
    }

    return updated;
  }

  async deleteAvatar(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (user.avatarUrl) {
      await this.deleteFile(user.avatarUrl);
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: null },
      select: { id: true, avatarUrl: true },
    });
  }

  // ─── TOURNAMENT BANNER ──────────────────────────────────────────

  async updateBanner(tournamentId: string, file: Express.Multer.File) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');

    // Same ordering rule as avatars: save the new file and commit the record
    // before deleting the old one, so a failed upload cannot destroy the
    // existing banner.
    const newUrl = await this.processAndSave(file, 'banners');
    const updated = await this.prisma.tournament.update({
      where: { id: tournamentId },
      data: { bannerUrl: newUrl },
      select: { id: true, bannerUrl: true },
    });

    if (tournament.bannerUrl && tournament.bannerUrl !== newUrl) {
      await this.deleteFile(tournament.bannerUrl);
    }

    return updated;
  }

  async deleteBanner(tournamentId: string) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');

    if (tournament.bannerUrl) {
      await this.deleteFile(tournament.bannerUrl);
    }

    return this.prisma.tournament.update({
      where: { id: tournamentId },
      data: { bannerUrl: null },
      select: { id: true, bannerUrl: true },
    });
  }

  // ─── SITE ASSETS ───────────────────────────────────────────────

  async upsertAsset(key: string, file: Express.Multer.File, label?: string) {
    const existing = await this.prisma.siteAsset.findUnique({ where: { key } });

    // Same ordering rule as avatars and banners: the old asset is only removed
    // once its replacement is on disk and committed.
    const newUrl = await this.processAndSave(file, 'assets');

    const saved = await this.prisma.siteAsset.upsert({
      where: { key },
      create: { key, url: newUrl, label },
      update: { url: newUrl, label },
    });

    if (existing?.url && existing.url !== newUrl) {
      await this.deleteFile(existing.url);
    }

    return saved;
  }

  async deleteAsset(key: string) {
    const asset = await this.prisma.siteAsset.findUnique({ where: { key } });
    if (!asset) throw new NotFoundException('Asset not found');

    await this.deleteFile(asset.url);
    return this.prisma.siteAsset.delete({ where: { key } });
  }

  async getAllAssets() {
    return this.prisma.siteAsset.findMany({
      orderBy: { key: 'asc' },
    });
  }
}
