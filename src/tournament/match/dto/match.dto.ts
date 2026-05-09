import { IsUUID, IsOptional, IsNotEmpty } from 'class-validator';

export class SubmitResultDto {
  @IsUUID('4')
  @IsOptional()
  winnerId?: string;
}

export class GameResultDto {
  @IsUUID('4')
  @IsNotEmpty()
  gameWinnerId!: string;  // ID of the player who won this single game/set
}