import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { Role, AuditCategory as AC } from '@prisma/client';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../guards/decorators/roles.decorator';
import { Audit } from '../audit/audit.decorator';
import { HomeService } from './home.service';
import { ReorderHomeBlocksDto, UpdateHomeBlockDto } from './home.dto';

@Controller('home')
export class HomeController {
  constructor(private readonly homeService: HomeService) {}

  /** Public: the landing page reads this on every render. */
  @Get()
  getConfig() {
    return this.homeService.getConfig();
  }

  // ─── Admin ──────────────────────────────────────────────────────

  // Declared before `blocks/:key`, which would otherwise swallow it with
  // key = "reorder".
  @Audit({
    action: 'home.reorder',
    category: AC.SYSTEM,
    pick: ['keys'],
    describe: (c) =>
      `Reordered the home page sections (${(c.body.keys as string[] | undefined)?.join(', ') ?? ''})`,
  })
  @Patch('blocks/reorder')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  reorder(@Body() dto: ReorderHomeBlocksDto) {
    return this.homeService.reorder(dto);
  }

  @Audit({
    action: 'home.update',
    category: AC.SYSTEM,
    pick: ['visible'],
    describe: (c) =>
      c.body.visible === undefined
        ? `Edited the home page section "${c.params.key}"`
        : `${c.body.visible ? 'Showed' : 'Hid'} the home page section "${c.params.key}"`,
  })
  @Patch('blocks/:key')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  updateBlock(@Param('key') key: string, @Body() dto: UpdateHomeBlockDto) {
    return this.homeService.updateBlock(key, dto);
  }
}
