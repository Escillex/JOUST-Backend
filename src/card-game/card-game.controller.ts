import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { CardGameService } from './card-game.service';
import { CreateCardGameDto } from './dto/create-card-game.dto';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';
import { RolesGuard } from 'src/guards/roles.guard';
import { Roles } from 'src/guards/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Controller('card-games')
export class CardGameController {
  constructor(private readonly cardGameService: CardGameService) {}

  @Get()
  async listCardGames() {
    return this.cardGameService.listCardGames();
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  async createCardGame(@Body() dto: CreateCardGameDto) {
    return this.cardGameService.createCardGame(dto);
  }
}
