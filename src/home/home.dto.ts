import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

/**
 * A block's `content` is deliberately typed as a bare object here and checked
 * for real in `HomeService.sanitizeContent`: its shape differs per block, and a
 * class-validator schema per key would have to be kept in step with the editor
 * anyway. The service whitelists the fields it knows, so nothing an admin sends
 * reaches the database unchecked — in particular no `javascript:` href.
 */
export class UpdateHomeBlockDto {
  @IsOptional()
  @IsBoolean()
  visible?: boolean;

  @IsOptional()
  @IsObject()
  content?: Record<string, unknown>;
}

export class ReorderHomeBlocksDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(32)
  @IsString({ each: true })
  keys!: string[];
}
