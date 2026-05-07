import {
  IsArray,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
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

export class ConvertGuestDto {
  @IsNotEmpty()
  @IsString()
  @MinLength(3)
  public username!: string;

  @IsNotEmpty()
  @IsEmail()
  public email!: string;

  @IsNotEmpty()
  @IsString()
  @Length(3, 20)
  public password!: string;
}

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  public username?: string;

  @IsOptional()
  @IsEmail()
  public email?: string;

  @IsOptional()
  @IsString()
  @Length(3, 20)
  public password?: string;
}

export class AdminCreateUserDto {
  @IsNotEmpty()
  @IsString()
  @MinLength(3)
  public username!: string;

  @IsNotEmpty()
  @IsEmail()
  public email!: string;

  @IsNotEmpty()
  @IsString()
  @Length(3, 20)
  public password!: string;

  @IsOptional()
  @IsArray()
  @IsEnum(Role, { each: true })
  public roles?: Role[];
}
