import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { BackupService } from './backup.service';
import { CreateBackupDto, UpdateBackupDto } from './dto/backup.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../guards/decorators/roles.decorator';
import { Audit } from '../audit/audit.decorator';
import { AuditCategory as AC } from '@prisma/client';

/**
 * Database backups, from the browser.
 *
 * ADMIN-only throughout, and deliberately NOT served from the static `/uploads`
 * mount: a backup file is every address and password hash in the system, and
 * static hosting has no idea who is asking.
 */
@Controller('admin/backups')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class BackupController {
  constructor(private readonly backups: BackupService) {}

  @Get()
  async list() {
    return {
      backups: await this.backups.list(),
      directory: await this.backups.directory(),
      sanitizedPassword: this.backups.sanitizedPassword,
    };
  }

  @Audit({ action: 'backup.create', category: AC.SYSTEM, pick: ['alias', 'sanitized'], describe: (c) => `Created a ${c.body.sanitized ? 'sanitized export' : 'backup'}${c.body.alias ? ` "${String(c.body.alias)}"` : ''}` })
  @Post()
  async create(@Body() dto: CreateBackupDto) {
    return this.backups.create({
      alias: dto.alias,
      description: dto.description,
      sanitized: dto.sanitized,
      trigger: 'manual',
    });
  }

  @Audit({ action: 'backup.update', category: AC.SYSTEM, pick: ['alias', 'pinned'], describe: (c) => `Updated the backup ${c.params.name}` })
  @Patch(':name')
  async update(@Param('name') name: string, @Body() dto: UpdateBackupDto) {
    return this.backups.update(name, dto);
  }

  @Get(':name/download')
  async download(@Param('name') name: string, @Res() res: Response) {
    const path = await this.backups.pathFor(name);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.sendFile(path);
  }

  @Audit({ action: 'backup.import', category: AC.SYSTEM, describe: (c) => `Imported a backup as ${String((c.result as { name?: string })?.name ?? 'a new file')}` })
  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  async import(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file was uploaded.');
    if (!file.originalname.endsWith('.joustql')) {
      throw new BadRequestException(
        'Only .joustql files can be imported. A plain SQL or pg_dump file carries no manifest, so there is no way to tell whether it belongs to this application.',
      );
    }
    // The interceptor holds the upload in memory (as the images module does);
    // the validator reads from a path, so stage it and let the service clean up.
    const staged = join(tmpdir(), `joust-import-${randomBytes(6).toString('hex')}.joustql`);
    await fs.writeFile(staged, file.buffer);
    return this.backups.importFile(staged, file.originalname);
  }

  /**
   * Overwrite the database, then restart.
   *
   * Answering before restarting is the point: the response tells the UI a
   * restart is coming so it can poll /health, instead of the request dying
   * mid-flight and looking like a failure.
   */
  @Audit({ action: 'backup.restore', category: AC.SYSTEM, describe: (c) => `Restored the database from ${c.params.name}` })
  @Post(':name/restore')
  async restore(@Param('name') name: string) {
    const result = await this.backups.restore(name);
    const restarting = this.backups.scheduleRestart();
    return {
      ...result,
      restarting,
      message: restarting
        ? 'Restored. The server is restarting to clear stale state.'
        : 'Restored. Reload the page.',
    };
  }

  @Audit({ action: 'backup.delete', category: AC.SYSTEM, describe: (c) => `Deleted the backup ${c.params.name}` })
  @Delete(':name')
  async remove(@Param('name') name: string) {
    await this.backups.remove(name);
    return { message: 'Backup deleted' };
  }
}
