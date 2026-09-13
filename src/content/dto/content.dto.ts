import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { BuildKind, BuildVisibility, ReportReason } from '@prisma/client';

/** Mirrors the frontend's limit; long enough for a full decklist. */
export const BUILD_TEXT_MAX = 4000;
export const CAPTION_MAX = 140;

/**
 * Submitting (or replacing) a build. Arrives as multipart when it is an image,
 * so every field is a string on the wire; the image itself is the `image` file.
 */
export class SubmitBuildDto {
  @IsEnum(BuildKind)
  public kind!: BuildKind;

  @ValidateIf((o: SubmitBuildDto) => o.kind === BuildKind.TEXT)
  @IsString()
  @IsNotEmpty({ message: 'Write the build out, or choose image or link instead.' })
  @MaxLength(BUILD_TEXT_MAX, { message: `A text build can be at most ${BUILD_TEXT_MAX} characters.` })
  public text?: string;

  /** https only: a build link is shown to other players, and an http or
   *  javascript: URL has no business on the page. */
  @ValidateIf((o: SubmitBuildDto) => o.kind === BuildKind.LINK)
  @IsUrl(
    { protocols: ['https'], require_protocol: true, require_valid_protocol: true },
    { message: 'A build link must be a full https:// address.' },
  )
  @MaxLength(500)
  public url?: string;
}

export class ReviewBuildDto {
  @IsIn(['APPROVED', 'REJECTED'])
  public decision!: 'APPROVED' | 'REJECTED';

  /** Required when rejecting — the player needs to know what to fix. */
  @ValidateIf((o: ReviewBuildDto) => o.decision === 'REJECTED')
  @IsString()
  @IsNotEmpty({ message: 'Tell the player why the build was rejected.' })
  @MaxLength(300)
  public note?: string;
}

export class BuildSettingsDto {
  @IsOptional()
  @IsBoolean()
  public buildsRequired?: boolean;

  @IsOptional()
  @IsEnum(BuildVisibility)
  public buildVisibility?: BuildVisibility;

  @IsOptional()
  @IsBoolean()
  public buildsLockAtStart?: boolean;
}

export class GalleryCaptionDto {
  @IsOptional()
  @IsString()
  @MaxLength(CAPTION_MAX)
  public caption?: string;
}

export class ReportDto {
  @IsIn(['GALLERY_IMAGE', 'TOURNAMENT_BUILD'])
  public targetType!: 'GALLERY_IMAGE' | 'TOURNAMENT_BUILD';

  @IsUUID()
  public targetId!: string;

  @IsEnum(ReportReason)
  public reason!: ReportReason;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  public note?: string;
}

export class ModerationTargetDto {
  @IsIn(['GALLERY_IMAGE', 'TOURNAMENT_BUILD'])
  public targetType!: 'GALLERY_IMAGE' | 'TOURNAMENT_BUILD';

  @IsUUID()
  public targetId!: string;
}

export class ModerationRemoveDto extends ModerationTargetDto {
  @IsString()
  @IsNotEmpty({ message: 'Give a reason — the owner is told why it was removed.' })
  @MaxLength(300)
  public reason!: string;
}
