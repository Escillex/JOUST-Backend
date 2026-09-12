import { AwardKind } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** Creating a catalog entry. Arrives as multipart (the artwork travels with
 *  it), so every field is a string on the wire. */
export class CreateAwardDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  public name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  public description?: string;

  @IsEnum(AwardKind)
  public kind!: AwardKind;
}

export class UpdateAwardDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  public name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  public description?: string;

  /** Archived awards cannot be given, but stay on profiles that hold them. */
  @IsOptional()
  @IsBoolean()
  public archived?: boolean;
}

export class GrantAwardDto {
  @IsUUID()
  public awardId!: string;

  /** Why — "Won the Winter Invitational". Shown on the profile. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  public note?: string;
}

/** The whole showcase at once: which medals are pinned (in slot order) and
 *  which plaque sits under the name. Sent whole rather than as individual
 *  pin/unpin calls so the result can never be a half-applied state. */
export class ShowcaseDto {
  @IsArray()
  @ArrayMaxSize(3, { message: 'At most three medals can be pinned.' })
  @IsUUID('all', { each: true })
  public pinnedMedals!: string[];

  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  public plaque!: string | null;
}
