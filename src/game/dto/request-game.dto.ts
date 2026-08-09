import { IsString, IsOptional, MinLength, MaxLength } from 'class-validator';

/** An organizer asks admins to add a game the catalog does not have yet. This
 *  files a request only — it never creates a game (games are admin-owned). The
 *  tournament, if given, runs under "General" until an admin creates + reassigns
 *  it (todo.md §5). */
export class RequestGameDto {
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name!: string;

  // Optional context for the admins: which tournament prompted the request.
  @IsOptional()
  @IsString()
  tournamentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  note?: string;
}
