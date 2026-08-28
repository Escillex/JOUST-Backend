import {
  IsString,
  IsEnum,
  IsOptional,
  IsBoolean,
  IsObject,
  MinLength,
  MaxLength,
} from 'class-validator';
import { PartialType } from '@nestjs/mapped-types';
import { TournamentSystem } from '@prisma/client';

export class CreateTournamentFormatDto {
  @IsString()
  @MinLength(3)
  @MaxLength(60)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  gameName?: string;

  // Optional default game this preset pre-fills at tournament creation (todo.md §5).
  @IsOptional()
  @IsString()
  gameId?: string;

  @IsEnum(TournamentSystem, {
    message: `system must be one of: ${Object.values(TournamentSystem).join(', ')}`,
  })
  system!: TournamentSystem;

  // We accept the config blob as-is. Validation is handled by the frontend form
  // and contextually within the service based on the system type.
  @IsObject()
  config!: Record<string, any>;

  @IsOptional()
  @IsBoolean()
  isBuiltin?: boolean;
}

// Real DTO for PATCH bodies — `Partial<CreateTournamentFormatDto>` erases to
// `Object` at runtime and bypasses the global whitelist ValidationPipe (F11).
export class UpdateTournamentFormatDto extends PartialType(
  CreateTournamentFormatDto,
) {}
