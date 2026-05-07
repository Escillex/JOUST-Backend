import { IsUUID, IsString, MinLength, MaxLength, IsInt, Min } from 'class-validator';

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
