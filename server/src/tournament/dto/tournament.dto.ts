import {
  IsString,
  IsInt,
  IsEnum,
  IsUUID,
  Min,
  Max,
  MinLength,
  MaxLength,
  IsNumber,
  IsOptional,
  IsBoolean,
} from 'class-validator';
import { TournamentFormat } from '@prisma/client';

// ─── CREATE TOURNAMENT ───────────────────────────────────────────

export class CreateTournamentDto {
  @IsString()
  @MinLength(3, { message: 'Tournament name must be at least 3 characters' })
  @MaxLength(60, { message: 'Tournament name must be at most 60 characters' })
  name: string;

  @IsEnum(TournamentFormat, {
    message: `Format must be one of: ${Object.values(TournamentFormat).join(', ')}`,
  })
  format: TournamentFormat;

  @IsInt()
  @Min(2, { message: 'Tournament needs at least 2 players' })
  @Max(128, { message: 'Tournament cannot exceed 128 players' })
  maxPlayers: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  prizePool?: number;

  @IsBoolean()
  @IsOptional()
  isPrivate?: boolean;

  @IsUUID('4', { message: 'createdById must be a valid UUID' })
  createdById: string;
}

// ─── UPDATE TOURNAMENT ───────────────────────────────────────────

import { PartialType } from '@nestjs/mapped-types';

export class UpdateTournamentDto extends PartialType(CreateTournamentDto) {}
