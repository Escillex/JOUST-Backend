import {
  IsUUID,
  IsString,
  IsOptional,
  MinLength,
  MaxLength,
  IsInt,
  Min,
} from 'class-validator';

export class JoinTournamentDto {
  @IsUUID('4')
  userId!: string;
}

export class JoinGuestDto {
  @IsString()
  @MinLength(3, { message: 'Username must be at least 3 characters long' })
  @MaxLength(40, { message: 'Username cannot exceed 40 characters' })
  username!: string;
}

export class UpdateSeedDto {
  @IsInt()
  @Min(1)
  seed!: number;
}

// Exactly one of the two fields is expected: an existing account takes over the
// slot, or a new guest is created for it. The service rejects the request when
// neither is supplied; both fields are declared here because the global
// ValidationPipe runs with forbidNonWhitelisted and would 400 an undeclared one.
export class ReplaceParticipantDto {
  @IsOptional()
  @IsUUID('4')
  substituteUserId?: string;

  @IsOptional()
  @IsString()
  @MinLength(3, { message: 'Name must be at least 3 characters long' })
  @MaxLength(40, { message: 'Name cannot exceed 40 characters' })
  guestName?: string;
}
