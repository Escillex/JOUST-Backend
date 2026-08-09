import {
  IsString,
  IsOptional,
  IsEnum,
  IsObject,
  MinLength,
  MaxLength,
} from 'class-validator';
import { GameTrackingMode } from '@prisma/client';

export class CreateGameDto {
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  description?: string;

  @IsOptional()
  @IsString()
  iconUrl?: string;

  @IsOptional()
  @IsEnum(GameTrackingMode, {
    message: `trackingMode must be one of: ${Object.values(GameTrackingMode).join(', ')}`,
  })
  trackingMode?: GameTrackingMode;

  // Optional rule defaults a format/tournament of this game can inherit. Accepted
  // as-is (same convention as TournamentFormat.config).
  @IsOptional()
  @IsObject()
  defaultConfig?: Record<string, any>;
}
