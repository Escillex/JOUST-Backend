import { IsUUID } from 'class-validator';

export class InviteOrganizerDto {
  @IsUUID('4')
  userId!: string;
}
