import { Controller, Get, Param, Query } from '@nestjs/common';
import { UserService } from './user.service';

@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  // Public profile bundle, resolved by slug OR legacy UUID. Declared before the
  // ':id/...' routes so 'profile' is unambiguous.
  @Get(':handle/profile')
  async getPublicProfile(@Param('handle') handle: string) {
    return this.userService.getPublicProfile(handle);
  }

  /** Full match history, grouped by tournament, paged by tournament
   *  (`?offset=0&limit=8`). Public like the profile. */
  @Get(':handle/match-history')
  async getMatchHistory(
    @Param('handle') handle: string,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ) {
    return this.userService.getMatchHistory(handle, Number(offset ?? 0), Number(limit ?? 8));
  }

  @Get(':id/stats')
  async getUserStats(@Param('id') id: string) {
    return this.userService.getUserStats(id);
  }

  @Get(':id/matches')
  async getUserMatches(@Param('id') id: string) {
    return this.userService.getUserMatches(id);
  }
}
