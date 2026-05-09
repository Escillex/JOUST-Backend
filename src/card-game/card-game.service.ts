import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { CreateCardGameDto } from './dto/create-card-game.dto';

export interface CardGameSummary {
  id: string;
  name: string;
  description?: string | null;
  isBuiltin: boolean;
}

const BUILT_IN_CARD_GAMES: CardGameSummary[] = [
  {
    id: 'builtin-magic-the-gathering',
    name: 'Magic: The Gathering',
    description: 'Built-in fantasy card game with mana, creatures, and sorcery.',
    isBuiltin: true,
  },
  {
    id: 'builtin-pokemon-tcg',
    name: 'Pokémon TCG',
    description: 'Built-in trading card game with Pokémon creatures and trainer strategies.',
    isBuiltin: true,
  },
  {
    id: 'builtin-yugioh',
    name: 'Yu-Gi-Oh!',
    description: 'Built-in duel game featuring monsters, spells, and trap cards.',
    isBuiltin: true,
  },
];

@Injectable()
export class CardGameService {
  constructor(private prisma: PrismaService) {}

  async listCardGames(): Promise<CardGameSummary[]> {
    await this.ensureBuiltInCardGames();

    const savedGames = await this.prisma.cardGame.findMany({
      where: { isBuiltin: false },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        isBuiltin: true,
      },
    });

    return [...BUILT_IN_CARD_GAMES, ...savedGames];
  }

  async createCardGame(dto: CreateCardGameDto) {
    const normalizedName = dto.name.trim();
    if (!normalizedName) {
      throw new BadRequestException('Card game name is required');
    }

    const existingBuiltin = BUILT_IN_CARD_GAMES.find(
      (game) => game.name.toLowerCase() === normalizedName.toLowerCase(),
    );
    if (existingBuiltin) {
      return this.prisma.cardGame.upsert({
        where: { id: existingBuiltin.id },
        create: {
          id: existingBuiltin.id,
          name: existingBuiltin.name,
          description: existingBuiltin.description,
          isBuiltin: true,
        },
        update: {
          description: existingBuiltin.description,
          isBuiltin: true,
        },
      });
    }

    const existing = await this.prisma.cardGame.findUnique({
      where: { name: normalizedName },
    });
    if (existing) {
      return existing;
    }

    return this.prisma.cardGame.create({
      data: {
        name: normalizedName,
        description: dto.description?.trim() || null,
        isBuiltin: false,
      },
    });
  }

  private async ensureBuiltInCardGames() {
    const upsertPromises = BUILT_IN_CARD_GAMES.map((game) =>
      this.prisma.cardGame.upsert({
        where: { id: game.id },
        create: {
          id: game.id,
          name: game.name,
          description: game.description,
          isBuiltin: true,
        },
        update: {
          description: game.description,
          isBuiltin: true,
        },
      }),
    );
    await Promise.all(upsertPromises);
  }
}
