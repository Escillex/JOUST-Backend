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
  IsObject,
  Matches,
} from 'class-validator';
import { TournamentStatus } from '@prisma/client';
import { PartialType } from '@nestjs/mapped-types';

// ─── CREATE TOURNAMENT ───────────────────────────────────────────

export class CreateTournamentDto {
  @IsString()
  @MinLength(3, { message: 'Tournament name must be at least 3 characters' })
  @MaxLength(60, { message: 'Tournament name must be at most 60 characters' })
  name!: string;

  @IsString()
  @IsOptional()
  @MaxLength(500, { message: 'Description must be at most 500 characters' })
  description?: string;

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

  /** Per-tournament rules override; fully replaces the format preset's config.
   *  Explicit null (on update) clears the override. */
  @IsObject()
  @IsOptional()
  config?: Record<string, any> | null;

  /** Short invite-link name (e.g. "summer-cup"). Only lowercase letters,
   *  numbers, and dashes are allowed so the value is always safe to put in
   *  a URL. When omitted on create, one is generated from the tournament
   *  name. An empty string on update clears the custom name. */
  @IsString()
  @IsOptional()
  @Matches(/^[a-z0-9-]*$/, {
    message:
      'Invite link name can only contain lowercase letters, numbers, and dashes',
  })
  @MaxLength(40, {
    message: 'Invite link name must be at most 40 characters',
  })
  slug?: string;
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
