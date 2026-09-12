import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Role } from '@prisma/client';

/**
 * What a username may contain: letters, digits, dot, underscore, hyphen — and
 * notably NOT spaces. A space has to be percent-encoded in a URL, is invisible
 * when doubled, and makes a name impossible to type back reliably.
 *
 * Existing accounts with spaces are deliberately left alone (grandfathered,
 * 2026-09-10): they are display names people already know, and `User.slug`
 * already gives them working profile links. The rule applies where a username is
 * chosen or changed — signup, admin create, guest conversion, rename — so the
 * set of spaced names can only shrink.
 *
 * Guest accounts are exempt on purpose: a walk-in entered at the desk is a real
 * person's name ("John Smith"), never a login, and forcing an organizer to strip
 * the space would make the roster read worse for no benefit.
 */
export const USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Password floor. It was `@Length(3, 20)`, so `"abc"` was a valid password —
 * and the 20-character ceiling was arbitrary (bcrypt handles 72 bytes), which
 * only ever discouraged passphrases. A second factor on top of a 3-character
 * password is a deadbolt on a screen door, so the floor is raised as part of the
 * same work.
 *
 * Applied where a password is SET (signup, admin create, guest conversion,
 * profile update). Sign-in stays unrestricted: existing short passwords keep
 * working until their owner changes them, exactly as spaced usernames were
 * grandfathered.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_RULE_MESSAGE = `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
export const USERNAME_RULE = {
  message:
    'Username can use letters, numbers, dots, underscores and hyphens — no spaces.',
};

/** Sign-IN. Neither field carries a format rule on purpose: the identifier may
 *  be an email or a legacy username with a space in it, and the password may
 *  predate the length floor. Validating either here would reject the credential
 *  before it is even checked, locking existing accounts out of their own logins.
 *  The rules live on the DTOs that SET these values. */
export class AuthDto {
  @IsNotEmpty()
  @IsString()
  @MinLength(3)
  public identifier!: string;

  @IsNotEmpty()
  @IsString()
  public password!: string;
}

/** Sign-UP. Same shape as AuthDto, but the identifier is a NEW username and so
 *  must satisfy the rule. */
export class SignUpDto extends AuthDto {
  /** The desired username. */
  @Matches(USERNAME_PATTERN, USERNAME_RULE)
  @Length(3, 20)
  declare public identifier: string;

  /**
   * Required as of 2026-09-11, because registration now verifies the address and
   * the emailed code is the account's second factor.
   *
   * Signup used to accept a bare username and fabricate
   * `user_<name>@example.com` for it. That address belongs to IANA's reserved
   * example domain and can never receive mail — which is why every seeded
   * account had one. An account created that way could not be verified, could
   * not receive a sign-in code, and so could not log in at all under the new
   * rules.
   */
  @IsEmail({}, { message: 'A valid email address is required.' })
  public email!: string;

  /** The human-readable name — "Paul Scholes". Optional, free-form, not unique;
   *  the handle above is what must be unique. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  public displayName?: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_RULE_MESSAGE })
  declare public password: string;
}

/** Submitting an emailed code — for both registration verification and sign-in.
 *  `challenge` is the short-lived token handed back by the previous step. */
export class VerifyCodeDto {
  @IsString()
  @IsNotEmpty()
  public challenge!: string;

  @IsString()
  @Length(6, 6, { message: 'Enter the 6-digit code from your email.' })
  public code!: string;

  @IsOptional()
  @IsBoolean()
  public rememberDevice?: boolean;
}

/** Using a recovery code instead of an emailed one. */
export class RecoveryCodeDto {
  @IsString()
  @IsNotEmpty()
  public challenge!: string;

  @IsString()
  @IsNotEmpty()
  public recoveryCode!: string;
}

export class ResendCodeDto {
  @IsString()
  @IsNotEmpty()
  public challenge!: string;
}

export class UpdateRolesDto {
  @IsArray()
  @IsEnum(Role, { each: true })
  public roles!: Role[];
}

export class ConvertGuestDto {
  @IsNotEmpty()
  @IsString()
  @Length(3, 20)
  @Matches(USERNAME_PATTERN, USERNAME_RULE)
  public username!: string;

  @IsNotEmpty()
  @IsEmail()
  public email!: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_RULE_MESSAGE })
  public password!: string;
}

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @Length(3, 20)
  @Matches(USERNAME_PATTERN, USERNAME_RULE)
  public username?: string;

  /** Free-form and not unique — spaces are fine here, which is the whole point
   *  of splitting it from the handle. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  public displayName?: string;

  @IsOptional()
  @IsEmail()
  public email?: string;

  @IsOptional()
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_RULE_MESSAGE })
  public password?: string;
}

export class AdminCreateUserDto {
  @IsNotEmpty()
  @IsString()
  @Length(3, 20)
  @Matches(USERNAME_PATTERN, USERNAME_RULE)
  public username!: string;

  @IsNotEmpty()
  @IsEmail()
  public email!: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_RULE_MESSAGE })
  public password!: string;

  @IsOptional()
  @IsArray()
  @IsEnum(Role, { each: true })
  public roles?: Role[];
}

/** The ID token Google's sign-in script hands the browser. Verified server-side
 *  against the Client ID in Admin → Settings. */
export class GoogleCredentialDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  public credential!: string;
}
