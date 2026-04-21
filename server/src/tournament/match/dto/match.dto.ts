import { IsUUID, IsOptional } from 'class-validator';

export class SubmitResultDto {
  @IsUUID('4')
  @IsOptional()
  winnerId?: string;
}
