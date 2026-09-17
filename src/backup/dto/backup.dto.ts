import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
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

  /**
   * Lock a FULL backup to this passphrase instead of to the server's key, so
   * the file can be restored somewhere else (todo.md §6). Ignored for a
   * sanitized export, which is written unencrypted by design.
   *
   * Never logged and never audited — see the @Audit pick list on the route.
   */
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  public passphrase?: string;
}

/** Opening a passphrase-protected file, on import or restore. */
export class BackupPassphraseDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  public passphrase?: string;
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

/**
 * Emptying the database for debugging.
 *
 * `confirm` must repeat the database's own name. It is the same shape of
 * confirmation the restore UI uses, and it exists because this is the one
 * action in the application that destroys data outright rather than replacing
 * it with other data.
 */
export class ResetDataDto {
  /** `content` keeps accounts and catalogues; `everything` keeps only the
   *  server's own settings and the administrator making the request. */
  @IsOptional()
  @IsIn(['content', 'everything'])
  public scope?: 'content' | 'everything';

  @IsString()
  @MaxLength(120)
  public confirm!: string;
}
