import {
  IsEnum, IsInt, IsOptional, IsUUID, Min,
} from 'class-validator';
import { GameTrackingMode } from '@prisma/client';

/** Organizer opens a tracker for the next game in a match series. */
export class OpenTrackerDto {
  @IsEnum(GameTrackingMode)
  @IsOptional()
  mode?: GameTrackingMode;
  // Defaults to format's trackingMode if omitted ('POINTS' for most formats).

  @IsInt()
  @Min(1)
  @IsOptional()
  startingValue?: number;
  // Resolution order in TrackerService.openTracker():
  //   1. dto.startingValue  (organizer explicit override at match time)
  //   2. config.defaultStartingValue  (format-level override, e.g. 200 HP for Pokémon)
  //   3. config.bestOf  (auto-derived: e.g. 2 wins to advance)
}

/** Player or organizer updates running HP/score within the active game. */
export class UpdateTrackerDto {
  @IsInt()
  @Min(0)
  @IsOptional()
  player1Value?: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  player2Value?: number;
}

/** Organizer confirms the result of the current game in the series. */
export class SubmitGameDto {
  @IsUUID('4')
  @IsOptional()
  winnerId?: string;
  // Omit for a draw (only valid if format config has allowDraw: true).
}
