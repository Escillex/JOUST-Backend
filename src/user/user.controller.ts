import { Controller, Get, Param } from '@nestjs/common';
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

  @Get(':id/stats')
  async getUserStats(@Param('id') id: string) {
    return this.userService.getUserStats(id);
  }

  @Get(':id/matches')
  async getUserMatches(@Param('id') id: string) {
    return this.userService.getUserMatches(id);
  }
}
