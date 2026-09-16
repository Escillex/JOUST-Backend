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

/** Long enough for a sentence or two about yourself; short enough that the
 *  profile header stays a header. */
export const BIO_MAX_LENGTH = 300;

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

  /** Empty string clears it. */
  @IsOptional()
  @IsString()
  @MaxLength(BIO_MAX_LENGTH, { message: `Bio can be at most ${BIO_MAX_LENGTH} characters.` })
  public bio?: string;

  @IsOptional()
  @IsEmail()
  public email?: string;

  @IsOptional()
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_RULE_MESSAGE })
  public password?: string;
}

/** `PATCH /auth/me` — what a user may change about themselves with only a
 *  session. Password and email are deliberately absent: they need proof (see
 *  the account DTOs below), and the global ValidationPipe refuses them here. */
export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @Length(3, 20)
  @Matches(USERNAME_PATTERN, USERNAME_RULE)
  public username?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  public displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(BIO_MAX_LENGTH, { message: `Bio can be at most ${BIO_MAX_LENGTH} characters.` })
  public bio?: string;
}

/**
 * Proof for a sensitive change to a signed-in account. Which one is needed is
 * the server's call (`GET /auth/me/security` → `proof`): the emailed code when
 * this site can send mail, otherwise the current password.
 */
export class AccountProofDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  public currentPassword?: string;

  /** A fresh Google credential, for an account whose only way in is Google:
   *  signing in with it again proves the change as well as a password would. */
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  public googleCredential?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'The code is the 6 digits from the email.' })
  public code?: string;
}

export class ChangePasswordDto extends AccountProofDto {
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_RULE_MESSAGE })
  @MaxLength(200)
  public newPassword!: string;
}

export class ChangeEmailDto extends AccountProofDto {
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  public email!: string;
}

export class DeleteAccountDto extends AccountProofDto {
  /** The username, typed out — a deletion you cannot undo should not be one
   *  stray tap. */
  @IsString()
  @MaxLength(50)
  public confirm!: string;
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

/** Finishing a forced password change. The old password is not re-asked: it was
 *  proved to obtain `changeToken`, which is single-purpose and short-lived. */
export class ForcedPasswordChangeDto {
  @IsNotEmpty()
  @IsString()
  public changeToken!: string;

  /** Required only when the account's current address cannot receive mail. */
  @IsOptional()
  @IsEmail({}, { message: 'A valid email address is required.' })
  public email?: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_RULE_MESSAGE })
  public newPassword!: string;
}

/** Starting a reset. Deliberately just the identifier: the response is the same
 *  whether or not it matches, so nothing here can confirm an account exists. */
export class ForgotPasswordDto {
  @IsNotEmpty()
  @IsString()
  public identifier!: string;
}

/** Finishing a reset with the emailed code. */
export class ResetPasswordDto {
  @IsNotEmpty()
  @IsString()
  public challenge!: string;

  @IsNotEmpty()
  @IsString()
  public code!: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_RULE_MESSAGE })
  public newPassword!: string;
}

/** Finishing a reset with a recovery code — the door that survives a dead inbox. */
export class ResetWithRecoveryDto {
  @IsNotEmpty()
  @IsString()
  public identifier!: string;

  @IsNotEmpty()
  @IsString()
  public recoveryCode!: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_RULE_MESSAGE })
  public newPassword!: string;
}
