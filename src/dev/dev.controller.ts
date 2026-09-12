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
import { Audit } from '../audit/audit.decorator';
import { AuditCategory as AC } from '@prisma/client';

@Controller('dev')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class DevController {
  constructor(private readonly devService: DevService) {}

  @Audit({ action: 'participant.bulk_guests', category: AC.PARTICIPANT, tournament: { param: 'tournamentId' }, pick: ['count'], describe: (c) => `Generated ${String(c.body.count ?? 10)} guests in ${c.t}` })
  @Post('batch-guests/:tournamentId')
  async batchAddGuests(
    @Param('tournamentId') tournamentId: string,
    @Body('count') count: number = 10,
  ) {
    return this.devService.batchAddGuests(tournamentId, count);
  }

  @Audit({ action: 'system.guest_expiry', category: AC.SYSTEM, pick: ['days'], describe: (c) => `Set guest expiry to ${String(c.body.days)} days` })
  @Patch('config/guest-expiry')
  async setGuestExpiry(@Body('days') days: number) {
    return this.devService.setGuestExpiry(days);
  }

  @Audit({ action: 'tournament.delete', category: AC.TOURNAMENT, tournament: { param: 'id' }, describe: (c) => `Deleted tournament ${c.t}` })
  @Delete('tournament/:id')
  async deleteTournament(@Param('id') id: string) {
    return this.devService.deleteTournament(id);
  }

  /** Temporarily relax the second factor while debugging. In-memory: a restart
   *  puts it back. Refused in production without ALLOW_2FA_BYPASS. */
  @Audit({ action: 'system.two_factor_override', category: AC.SYSTEM, pick: ['mode'], describe: (c) => `Set two-factor enforcement to "${String(c.body.mode)}" until the next restart` })
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

  @Audit({ action: 'system.backfill_stats', category: AC.SYSTEM, describe: () => 'Rebuilt the per-game leaderboard stats' })
  @Post('backfill-game-stats')
  async backfillGameStats() {
    return this.devService.backfillGameStats();
  }
}
