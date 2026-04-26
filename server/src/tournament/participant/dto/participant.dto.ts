import { IsUUID, IsString, MinLength, MaxLength } from 'class-validator';

export class JoinTournamentDto {
  @IsUUID('4')
  userId!: string;
}

export class JoinGuestDto {
  @IsString()
  @MinLength(3, { message: 'Guest name must be at least 3 characters long' })
  @MaxLength(40, { message: 'Guest name cannot exceed 40 characters' })
  guestName!: string;
}
