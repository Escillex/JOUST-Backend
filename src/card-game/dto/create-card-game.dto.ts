import { IsString, MinLength, MaxLength, IsOptional } from 'class-validator';

export class CreateCardGameDto {
  @IsString()
  @MinLength(3, { message: 'Card game name must be at least 3 characters' })
  @MaxLength(80, { message: 'Card game name must be at most 80 characters' })
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(250, { message: 'Description must be at most 250 characters' })
  description?: string;
}
