import { IsIn, IsString, MaxLength } from 'class-validator';
import { EDITABLE_SETTINGS } from '../settings.keys';
import type { SettingName } from '../settings.keys';

export class UpdateSettingDto {
  /** Restricted to the editable catalog, so this endpoint cannot be used to
   *  write arbitrary keys — including `setup.completedAt`, which is set by
   *  finishing the wizard rather than by typing a value. */
  @IsIn(EDITABLE_SETTINGS)
  public name!: SettingName;

  @IsString()
  @MaxLength(500)
  public value!: string;
}

export class TestEmailDto {
  @IsString()
  @MaxLength(320)
  public to!: string;
}
