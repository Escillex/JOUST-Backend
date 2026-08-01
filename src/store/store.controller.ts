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

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  create(@Body() dto: CreateStoreProductDto) {
    return this.storeService.create(dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateStoreProductDto) {
    return this.storeService.update(id, dto);
  }

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

  @Delete(':id/image')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  removeImage(@Param('id') id: string) {
    return this.storeService.removeImage(id);
  }

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
