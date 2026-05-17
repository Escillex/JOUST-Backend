import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { CreateStoreProductDto, UpdateStoreProductDto } from './store.dto';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class StoreService {
  private readonly uploadRoot = path.join(process.cwd(), '..', 'images');
  private readonly assetsDir = path.join(this.uploadRoot, 'assets');

  constructor(private prisma: PrismaService) {
    if (!fs.existsSync(this.assetsDir)) {
      fs.mkdirSync(this.assetsDir, { recursive: true });
    }
  }

  private async saveImage(file: Express.Multer.File): Promise<string> {
    const id = uuidv4();
    const fileName = `${id}.webp`;
    const outPath = path.join(this.assetsDir, fileName);

    await sharp(file.buffer)
      .resize(1200, null, { withoutEnlargement: true })
      .webp({ quality: 85 })
      .toFile(outPath);

    return `/uploads/assets/${fileName}`;
  }

  private deleteImage(url: string | null) {
    if (!url) return;
    const relativePath = url.replace('/uploads/', '');
    const absolutePath = path.join(this.uploadRoot, relativePath);
    if (fs.existsSync(absolutePath)) {
      try { fs.unlinkSync(absolutePath); } catch {}
    }
  }

  async findAll() {
    return this.prisma.storeProduct.findMany({
      orderBy: { sortOrder: 'asc' },
    });
  }

  async findVisible() {
    return this.prisma.storeProduct.findMany({
      where: { isVisible: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async findOne(id: string) {
    const product = await this.prisma.storeProduct.findUnique({ where: { id } });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  async create(dto: CreateStoreProductDto) {
    const maxOrder = await this.prisma.storeProduct.aggregate({ _max: { sortOrder: true } });
    const nextOrder = (maxOrder._max.sortOrder ?? -1) + 1;
    return this.prisma.storeProduct.create({
      data: {
        ...dto,
        sortOrder: dto.sortOrder ?? nextOrder,
      },
    });
  }

  async update(id: string, dto: UpdateStoreProductDto) {
    await this.findOne(id);
    return this.prisma.storeProduct.update({ where: { id }, data: dto });
  }

  async uploadImage(id: string, file: Express.Multer.File) {
    const product = await this.findOne(id);
    this.deleteImage(product.imageUrl);
    const imageUrl = await this.saveImage(file);
    return this.prisma.storeProduct.update({ where: { id }, data: { imageUrl } });
  }

  async removeImage(id: string) {
    const product = await this.findOne(id);
    this.deleteImage(product.imageUrl);
    return this.prisma.storeProduct.update({ where: { id }, data: { imageUrl: null } });
  }

  async remove(id: string) {
    const product = await this.findOne(id);
    this.deleteImage(product.imageUrl);
    return this.prisma.storeProduct.delete({ where: { id } });
  }

  async reorder(orderedIds: string[]) {
    const updates = orderedIds.map((id, i) =>
      this.prisma.storeProduct.update({ where: { id }, data: { sortOrder: i } }),
    );
    return this.prisma.$transaction(updates);
  }
}
