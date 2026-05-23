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
import { SubmitResultDto, GameResultDto } from './dto/match.dto';

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

  // POST /matches/:id/game-result
  @Post(':id/game-result')
  @HttpCode(HttpStatus.OK)
  async reportGameResult(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GameResultDto,
  ) {
    return this.matchService.reportGameResult(id, dto.gameWinnerId);
  }

  // POST /matches/:id/draw
  @Post(':id/draw')
  @HttpCode(HttpStatus.OK)
  async reportDraw(@Param('id', ParseUUIDPipe) id: string) {
    return this.matchService.reportDraw(id);
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
