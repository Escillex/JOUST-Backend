import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Req,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { MatchUtilityService } from './utility.service';
import { RollDiceDto, TimerActionDto } from './dto/utility.dto';
import {
  JwtAuthGuard,
  type AuthenticatedRequest,
} from '../../../guards/jwt-auth.guard';

// All triggers are gated *in the service* from the tournament's resolved config
// (utilityCoinWho / utilityDiceWho / utilityTimerWho), so — like the tracker's
// update route — they carry only JwtAuthGuard here. RolesGuard/TournamentAccessGuard
// would reject an allowed PLAYER before the per-match, per-config check can run.
@Controller('matches')
export class MatchUtilityController {
  constructor(private readonly utility: MatchUtilityService) {}

  /** GET /matches/:id/utility — public: state + resolved perms (spectator read). */
  @Get(':id/utility')
  getState(@Param('id', ParseUUIDPipe) id: string) {
    return this.utility.getState(id);
  }

  @Post(':id/utility/coin')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  coin(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.utility.flipCoin(id, req.user);
  }

  @Post(':id/utility/dice')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  dice(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RollDiceDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.utility.rollDice(id, dto, req.user);
  }

  @Post(':id/utility/timer')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  timer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TimerActionDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.utility.timer(id, dto, req.user);
  }
}
