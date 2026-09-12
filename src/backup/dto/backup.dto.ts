import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** Creating a backup on demand. Everything is optional: the common case is
 *  pressing the button and getting a timestamped file. */
export class CreateBackupDto {
  /** A human label. Setting one also pins the backup, because an alias is how
   *  somebody says "keep this one". */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  public alias?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  public description?: string;

  /** Scrub addresses and credentials — the copy that may leave the building. */
  @IsOptional()
  @IsBoolean()
  public sanitized?: boolean;
}

/** Labelling or pinning an existing backup after the fact. */
export class UpdateBackupDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  public alias?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  public description?: string | null;

  @IsOptional()
  @IsBoolean()
  public pinned?: boolean;
}
