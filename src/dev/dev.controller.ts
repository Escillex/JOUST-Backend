import { Controller, Post, Delete, Patch, Param, Body, UseGuards } from '@nestjs/common';
import { DevService } from './dev.service';
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
}
