import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { NotificationService } from './notification.service';
import {
  JwtAuthGuard,
  type AuthenticatedRequest,
} from 'src/guards/jwt-auth.guard';

// Every route is scoped to req.user.id. The user id is never read from a param
// or body, so one account can never reach another's inbox.
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  // GET /notifications?unreadOnly=true&take=20&cursor=<id>
  @Get()
  @UseGuards(JwtAuthGuard)
  async list(
    @Req() req: AuthenticatedRequest,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('take') take?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.notifications.list(req.user.id, {
      unreadOnly: unreadOnly === 'true',
      take: take ? Number(take) : undefined,
      cursor: cursor || undefined,
    });
  }

  // PATCH /notifications/read-all
  // Declared before the ':id' route so "read-all" is not captured as an id.
  @Patch('read-all')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async markAllRead(@Req() req: AuthenticatedRequest) {
    await this.notifications.markAllRead(req.user.id);
    return { success: true };
  }

  // PATCH /notifications/:id/read
  @Patch(':id/read')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async markRead(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.notifications.markRead(req.user.id, id);
    return { success: true };
  }
}
