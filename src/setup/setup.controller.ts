import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Role, AuditCategory as AC } from '@prisma/client';
import { SettingsService } from '../settings/settings.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../guards/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../guards/jwt-auth.guard';
import { Audit } from '../audit/audit.decorator';

/**
 * First-run setup.
 *
 * The wizard configures nothing this API could not already do — it writes
 * through `PATCH /admin/settings` like the settings panel does. What lives here
 * is only the *state* of having finished, which is what lets `/admin` stop
 * nagging. `setup.completedAt` is excluded from `EDITABLE_SETTINGS` precisely so
 * it cannot be typed in as a value; this is its one writer.
 */
@Controller('setup')
export class SetupController {
  constructor(private readonly settings: SettingsService) {}

  /**
   * Unguarded on purpose. The banner decision has to be made before anything
   * else renders, and the answer is a single boolean about the deployment —
   * never a setting, never whether an admin exists. An anonymous caller learns
   * only whether somebody finished a checklist.
   */
  @Get('status')
  async status(): Promise<{ completed: boolean; completedAt: string | null }> {
    const at = await this.settings.get('SETUP_COMPLETED_AT');
    return { completed: !!at, completedAt: at };
  }

  /** Idempotent: re-running the wizard just re-stamps the date. */
  @Audit({
    action: 'system.setup_complete',
    category: AC.SYSTEM,
    describe: () => 'Completed the setup wizard',
  })
  @Post('complete')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  async complete(
    @Req() req: AuthenticatedRequest,
  ): Promise<{ message: string; completedAt: string }> {
    const userId = req.user.id || (req.user as { sub?: string }).sub;
    const completedAt = new Date().toISOString();
    await this.settings.set('SETUP_COMPLETED_AT', completedAt, userId);
    return { message: 'Setup complete', completedAt };
  }
}
