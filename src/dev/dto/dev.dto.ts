import { IsIn } from 'class-validator';

export class SetTwoFactorDto {
  /** `all` = everyone, `staff` = admins and organizers only, `off` = nobody.
   *  Applies until the process restarts. */
  @IsIn(['all', 'staff', 'off'])
  public mode!: 'all' | 'staff' | 'off';
}
