import {
  Controller,
  Get,
  Req,
  Post,
  Delete,
  Patch,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { DevService } from './dev.service';
import { SetTwoFactorDto } from './dto/dev.dto';
import type { AuthenticatedRequest } from '../guards/jwt-auth.guard';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../guards/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Controller('dev')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class DevController {
  constructor(private readonly devService: DevService) {}

  @Post('batch-guests/:tournamentId')
  async batchAddGuests(
    @Param('tournamentId') tournamentId: string,
    @Body('count') count: number = 10,
  ) {
    return this.devService.batchAddGuests(tournamentId, count);
  }

  @Patch('config/guest-expiry')
  async setGuestExpiry(@Body('days') days: number) {
    return this.devService.setGuestExpiry(days);
  }

  @Delete('tournament/:id')
  async deleteTournament(@Param('id') id: string) {
    return this.devService.deleteTournament(id);
  }

  /** Temporarily relax the second factor while debugging. In-memory: a restart
   *  puts it back. Refused in production without ALLOW_2FA_BYPASS. */
  @Patch('two-factor')
  setTwoFactor(@Body() dto: SetTwoFactorDto, @Req() req: AuthenticatedRequest) {
    return this.devService.setTwoFactorEnforcement(
      dto.mode,
      req.user?.id || (req.user as any)?.sub,
    );
  }

  @Get('two-factor')
  getTwoFactor() {
    return this.devService.getTwoFactorEnforcement();
  }

  @Post('backfill-game-stats')
  async backfillGameStats() {
    return this.devService.backfillGameStats();
  }
}
