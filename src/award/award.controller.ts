import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { AwardService } from './award.service';
import {
  CreateAwardDto,
  GrantAwardDto,
  ShowcaseDto,
  UpdateAwardDto,
} from './dto/award.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import type { AuthenticatedRequest } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../guards/decorators/roles.decorator';

/** Artwork is resized to at most 1200x300 or 512x512, so a larger upload buys
 *  nothing; the images module sets no limit of its own. */
const ART_UPLOAD = FileInterceptor('image', { limits: { fileSize: 5 * 1024 * 1024 } });

const callerId = (req: AuthenticatedRequest) =>
  req.user.id || (req.user as { sub?: string }).sub!;

/** The award catalog. Admin-only throughout. */
@Controller('awards')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AwardCatalogController {
  constructor(private readonly awards: AwardService) {}

  @Get()
  list(@Query('includeArchived') includeArchived?: string) {
    return this.awards.listCatalog(includeArchived === 'true');
  }

  @Post()
  @UseInterceptors(ART_UPLOAD)
  create(
    @Body() dto: CreateAwardDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.awards.create(dto, file, callerId(req));
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAwardDto) {
    return this.awards.update(id, dto);
  }

  @Post(':id/image')
  @UseInterceptors(ART_UPLOAD)
  replaceImage(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.awards.replaceImage(id, file);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.awards.remove(id);
  }
}

/** Giving and revoking awards. Admin-only. */
@Controller('users/:userId/awards')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AwardGrantController {
  constructor(private readonly awards: AwardService) {}

  @Get()
  list(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.awards.grantsFor(userId);
  }

  @Post()
  grant(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: GrantAwardDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.awards.grant(userId, dto, callerId(req));
  }

  @Delete(':grantId')
  revoke(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('grantId', ParseUUIDPipe) grantId: string,
  ) {
    return this.awards.revoke(userId, grantId);
  }
}

/** A user arranging their own showcase. Any signed-in account — but only ever
 *  its own grants, which the service checks. */
@Controller('users/me/showcase')
@UseGuards(JwtAuthGuard)
export class ShowcaseController {
  constructor(private readonly awards: AwardService) {}

  @Put()
  set(@Body() dto: ShowcaseDto, @Req() req: AuthenticatedRequest) {
    return this.awards.setShowcase(callerId(req), dto);
  }
}
