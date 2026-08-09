import { IsEnum } from 'class-validator';
import { GameRequestStatus } from '@prisma/client';

export class ResolveRequestDto {
  @IsEnum(GameRequestStatus, {
    message: `status must be one of: ${Object.values(GameRequestStatus).join(', ')}`,
  })
  status!: GameRequestStatus;
}
