import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../guards/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { StoreService } from './store.service';
import { CreateStoreProductDto, UpdateStoreProductDto } from './store.dto';
import { Audit } from '../audit/audit.decorator';
import { AuditCategory as AC } from '@prisma/client';

@Controller('store')
export class StoreController {
  constructor(private readonly storeService: StoreService) {}

  // Public: landing page reads
  @Get()
  findVisible() {
    return this.storeService.findVisible();
  }

  // Admin: full list including hidden items
  @Get('all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  findAll() {
    return this.storeService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.storeService.findOne(id);
  }

  // ─── Admin mutations ───────────────────────────────────────────

  @Audit({ action: 'store.create', category: AC.CATALOG, pick: ['name'], describe: (c) => `Added the store product "${String(c.body.name ?? '')}"` })
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  create(@Body() dto: CreateStoreProductDto) {
    return this.storeService.create(dto);
  }

  @Audit({ action: 'store.update', category: AC.CATALOG, subject: { model: 'storeProduct', param: 'id' }, describe: (c) => `Edited the store product "${c.subject}" (${c.fields.join(', ') || 'no changes'})` })
  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateStoreProductDto) {
    return this.storeService.update(id, dto);
  }

  @Audit({ action: 'store.image', category: AC.CATALOG, subject: { model: 'storeProduct', param: 'id' }, describe: (c) => `Changed the image of "${c.subject}"` })
  @Post(':id/image')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @UseInterceptors(FileInterceptor('file'))
  uploadImage(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.storeService.uploadImage(id, file);
  }

  @Audit({ action: 'store.image_remove', category: AC.CATALOG, subject: { model: 'storeProduct', param: 'id' }, describe: (c) => `Removed the image of "${c.subject}"` })
  @Delete(':id/image')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  removeImage(@Param('id') id: string) {
    return this.storeService.removeImage(id);
  }

  @Audit({ action: 'store.delete', category: AC.CATALOG, subject: { model: 'storeProduct', param: 'id' }, describe: (c) => `Deleted the store product "${c.subject}"` })
  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  remove(@Param('id') id: string) {
    return this.storeService.remove(id);
  }

  // PATCH /store/reorder/bulk was REMOVED (plan 7.5, 2026-07-31). No frontend
  // path ever existed for product ordering, so it was untested, unreachable
  // API surface. `StoreProduct.sortOrder` remains in the schema and is still
  // honoured when listing, so building the drag-to-order UI later only needs
  // the endpoint back — no data migration.
}
