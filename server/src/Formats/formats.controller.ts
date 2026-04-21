import { Controller } from '@nestjs/common';
import { FormatsService } from './formats.service';

@Controller('formats')
export class FormatsController {
  constructor(private readonly formatsService: FormatsService) {}
}
