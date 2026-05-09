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
  IsArray,
  IsObject,
  ValidateNested,
  IsPositive,
  IsDateString,
} from 'class-validator';
import { Prisma, TournamentFormat, TournamentStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { PartialType } from '@nestjs/mapped-types';

// ─── FORMAT CONFIG DTO ────────────────────────────────────────

export class FormatConfigDto {
  // Single/Double Elimination
  @IsOptional()
  @IsInt()
  @Min(1, { message: 'Wins to advance must be at least 1' })
  @Max(7, { message: 'Wins to advance cannot exceed 7' })
  winsToAdvance?: number;

  // Swiss
  @IsOptional()
  @IsInt()
  @Min(1, { message: 'Swiss rounds must be at least 1' })
  @Max(20, { message: 'Swiss rounds cannot exceed 20' })
  swissRounds?: number;

  @IsOptional()
  @IsInt()
  @Min(0, { message: 'Points for win cannot be negative' })
  swissPointsForWin?: number;

  @IsOptional()
  @IsInt()
  @Min(0, { message: 'Points for draw cannot be negative' })
  swissPointsForDraw?: number;

  @IsOptional()
  @IsInt()
  @Min(0, { message: 'Points for loss cannot be negative' })
  swissPointsForLoss?: number;

  // Points-based / Best-of
  @IsOptional()
  @IsInt()
  @IsPositive({ message: 'Points threshold must be positive' })
  pointsThreshold?: number;

  @IsOptional()
  @IsInt()
  @Min(1, { message: 'Sessions count must be at least 1' })
  @Max(10, { message: 'Sessions count cannot exceed 10' })
  sessionsCount?: number;

  @IsOptional()
  @IsInt()
  @IsPositive({ message: 'Points per session must be positive' })
  pointsPerSession?: number;

  @IsOptional()
  @IsInt()
  @Min(1, { message: 'Best-of must be at least 1' })
  bestOf?: number;

  @IsOptional()
  @IsBoolean()
  allowDraw?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tieBreakerOrder?: string[];

  @IsOptional()
  @IsString()
  progressionType?: string;
}

// ─── CREATE TOURNAMENT ───────────────────────────────────────────

export class CreateTournamentDto {
  @IsString()
  @MinLength(3, { message: 'Tournament name must be at least 3 characters' })
  @MaxLength(60, { message: 'Tournament name must be at most 60 characters' })
  name!: string;

  @IsEnum(TournamentFormat, {
    message: `Format must be one of: ${Object.values(TournamentFormat).join(', ')}`,
  })
  format!: TournamentFormat;

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

  @IsOptional()
  @IsString()
  cardGameId?: string;

  // ← NEW: Format Config
  @IsOptional()
  @ValidateNested()
  @Type(() => FormatConfigDto)
  formatConfig?: FormatConfigDto;
}

// ─── UPDATE TOURNAMENT ───────────────────────────────────────────

export class UpdateTournamentDto extends PartialType(CreateTournamentDto) {}

export class TournamentStatusDto {
  @IsEnum(TournamentStatus, {
    message: `Status must be one of: ${Object.values(TournamentStatus).join(', ')}`,
  })
  status!: TournamentStatus;
}
