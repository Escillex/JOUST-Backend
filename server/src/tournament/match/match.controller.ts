import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { MatchService } from './match.service';
import { SubmitResultDto } from './dto/match.dto';

@Controller('matches')
export class MatchController {
  constructor(private readonly matchService: MatchService) {}

  // POST /matches/:id/submit
  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  async submitResult(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitResultDto,
  ) {
    return this.matchService.submitResult(id, dto.winnerId);
  }

  // GET /matches/:id
  @Get(':id')
  async getMatch(@Param('id', ParseUUIDPipe) id: string) {
    return this.matchService.getMatch(id);
  }

  // GET /matches/round/:roundId
  @Get('round/:roundId')
  async getMatchesByRound(@Param('roundId', ParseUUIDPipe) roundId: string) {
    return this.matchService.getMatchesByRound(roundId);
  }
}
