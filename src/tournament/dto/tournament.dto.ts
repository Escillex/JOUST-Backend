import {
  IsString,
  IsInt,
  IsUUID,
  Min,
  Max,
  MinLength,
  MaxLength,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsEnum,
  IsDateString,
} from 'class-validator';
import { TournamentStatus } from '@prisma/client';
import { PartialType } from '@nestjs/mapped-types';

// ─── CREATE TOURNAMENT ───────────────────────────────────────────

export class CreateTournamentDto {
  @IsString()
  @MinLength(3, { message: 'Tournament name must be at least 3 characters' })
  @MaxLength(60, { message: 'Tournament name must be at most 60 characters' })
  name!: string;

  /** UUID of a TournamentFormat entity */
  @IsUUID('4', { message: 'formatId must be a valid UUID' })
  formatId!: string;

  @IsInt()
  @Min(2, { message: 'Tournament needs at least 2 players' })
  @Max(128, { message: 'Tournament cannot exceed 128 players' })
  maxPlayers!: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  prizePool?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  entranceFee?: number;

  @IsString()
  @IsOptional()
  venue?: string;

  @IsDateString()
  @IsOptional()
  date?: string;

  @IsBoolean()
  @IsOptional()
  isPrivate?: boolean;

  @IsBoolean()
  @IsOptional()
  startNow?: boolean;

  @IsUUID('4', { message: 'createdById must be a valid UUID' })
  createdById!: string;
}

// ─── UPDATE TOURNAMENT ───────────────────────────────────────────

export class UpdateTournamentDto extends PartialType(CreateTournamentDto) {}

// ─── STATUS TRANSITION ───────────────────────────────────────────

export class TournamentStatusDto {
  @IsEnum(TournamentStatus, {
    message: `Status must be one of: ${Object.values(TournamentStatus).join(', ')}`,
  })
  status!: TournamentStatus;
}
