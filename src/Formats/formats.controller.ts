import {
  Controller,
  Get,
  Param,
  ParseEnumPipe,
} from '@nestjs/common';
import { FormatsService } from './formats.service';
import { TournamentFormat } from '@prisma/client';

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
}
