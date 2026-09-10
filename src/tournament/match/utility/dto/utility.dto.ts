import { IsInt, IsOptional, IsIn, Min, Max } from 'class-validator';

/** One dice roll request. Defaults to a single six-sided die. Bounded so a
 *  request can't ask for absurd counts/sides. */
export class RollDiceDto {
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(100)
  sides?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  count?: number;
}

export type TimerAction = 'set' | 'start' | 'pause' | 'reset';

/** Control the shared match timer. `durationSec` is required for `set` and may
 *  accompany `start` (sets then starts). */
export class TimerActionDto {
  @IsIn(['set', 'start', 'pause', 'reset'])
  action!: TimerAction;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(86400)
  durationSec?: number;
}
