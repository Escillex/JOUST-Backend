import { IsUUID } from 'class-validator';

export class JoinTournamentDto {
  @IsUUID('4')
  userId!: string;
}
