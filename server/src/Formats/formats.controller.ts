import {
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  Body,
  Post,
  Patch,
  Delete,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { FormatsService } from './formats.service';
import { TournamentFormat, Role } from '@prisma/client';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../guards/decorators/roles.decorator';
import {
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

class FormatTemplateDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsEnum(TournamentFormat)
  format!: TournamentFormat;

  @IsObject()
  config!: Record<string, unknown>;
}

class UpdateFormatTemplateDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsEnum(TournamentFormat)
  @IsOptional()
  format?: TournamentFormat;

  @IsObject()
  @IsOptional()
  config?: Record<string, unknown>;
}

@Controller('formats')
export class FormatsController {
  constructor(private readonly formatsService: FormatsService) {}

  @Get()
  getFormats() {
    return {
      formats: this.formatsService.getAvailableFormats(),
    };
  }

  @Get('details')
  getFormatDetails() {
    return {
      formats: this.formatsService.getFormatDetails(),
    };
  }

  @Get('details/:format')
  getFormatDetailsByFormat(
    @Param('format', new ParseEnumPipe(TournamentFormat))
    format: TournamentFormat,
  ) {
    return this.formatsService.getFormatDetailsByFormat(format);
  }

  @Get('templates')
  getFormatTemplates() {
    return { templates: this.formatsService.getFormatTemplates() };
  }

  @Post('templates')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  createFormatTemplate(@Body() payload: FormatTemplateDto) {
    return this.formatsService.createFormatTemplate(payload);
  }

  @Patch('templates/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  updateFormatTemplate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() payload: UpdateFormatTemplateDto,
  ) {
    return this.formatsService.updateFormatTemplate(id, payload);
  }

  @Delete('templates/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  deleteFormatTemplate(@Param('id', ParseUUIDPipe) id: string) {
    return this.formatsService.deleteFormatTemplate(id);
  }
}
