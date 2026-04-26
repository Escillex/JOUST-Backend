import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsString,
  Length,
  MinLength,
} from 'class-validator';
import { Role } from '@prisma/client';

export class AuthDto {
  @IsNotEmpty()
  @IsString()
  @MinLength(3)
  public identifier!: string;

  @IsNotEmpty()
  @IsString()
  @Length(3, 20, {
    message: 'Password has to be at between 3 and 20 characters',
  })
  public password!: string;
}

export class UpdateRolesDto {
  @IsArray()
  @IsEnum(Role, { each: true })
  public roles!: Role[];
}
