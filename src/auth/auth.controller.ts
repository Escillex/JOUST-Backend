import {
  Controller,
  Post,
  Get,
  Delete,
  Patch,
  Body,
  Param,
  Res,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { GoogleAuthService } from './google-auth.service';
import { AccountService } from './account.service';
import {
  AccountProofDto,
  ChangeEmailDto,
  ChangePasswordDto,
  DeleteAccountDto,
  AdminCreateUserDto,
  ForcedPasswordChangeDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ResetWithRecoveryDto,
  AuthDto,
  ConvertGuestDto,
  GoogleCredentialDto,
  RecoveryCodeDto,
  ResendCodeDto,
  SignUpDto,
  UpdateMeDto,
  UpdateProfileDto,
  UpdateRolesDto,
  VerifyCodeDto,
} from './dto/auth.dto';
import * as express from 'express';
import {
  JwtAuthGuard,
  type AuthenticatedRequest,
} from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../guards/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { Audit } from '../audit/audit.decorator';
import { AuditCategory as AC } from '@prisma/client';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly google: GoogleAuthService,
    private readonly account: AccountService,
  ) {}

  // ──────────────────────────────────────────────
  // PUBLIC AUTH
  // ──────────────────────────────────────────────

  @Post('signup')
  signup(@Body() dto: SignUpDto) {
    return this.authService.SignUp(dto);
  }

  /** Password step. Returns a session only when no second factor is due —
   *  otherwise a short-lived challenge the client submits a code against. */
  @Post('signin')
  signin(
    @Body() dto: AuthDto,
    @Req() req: express.Request,
    @Res({ passthrough: true }) res: express.Response,
  ) {
    const deviceToken = (req.cookies as Record<string, string | undefined>)?.[
      'device'
    ];
    return this.authService.SignIn(dto, res, deviceToken);
  }

  /** Second step: the emailed code, for both registration and sign-in. */
  @Post('2fa/verify')
  submitCode(
    @Body() dto: VerifyCodeDto,
    @Req() req: express.Request,
    @Res({ passthrough: true }) res: express.Response,
  ) {
    return this.authService.submitCode(dto, res, req.headers['user-agent']);
  }

  /** The way back in when the inbox is unreachable. */
  @Post('2fa/recovery')
  submitRecovery(
    @Body() dto: RecoveryCodeDto,
    @Res({ passthrough: true }) res: express.Response,
  ) {
    return this.authService.submitRecoveryCode(
      dto.challenge,
      dto.recoveryCode,
      res,
    );
  }

  /**
   * Ask for a reset code. Unguarded and deliberately uninformative: the reply is
   * identical whether or not the account exists.
   */
  @Post('password/forgot')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.requestPasswordReset(dto.identifier);
  }

  /** Finish a reset with the emailed code. */
  @Post('password/reset')
  resetPassword(
    @Body() dto: ResetPasswordDto,
    @Res({ passthrough: true }) res: express.Response,
  ) {
    return this.authService.resetPasswordWithCode(
      dto.challenge,
      dto.code,
      dto.newPassword,
      res,
    );
  }

  /** Finish a reset with a recovery code, for a dead inbox. */
  @Post('password/reset-recovery')
  resetPasswordWithRecovery(
    @Body() dto: ResetWithRecoveryDto,
    @Res({ passthrough: true }) res: express.Response,
  ) {
    return this.authService.resetPasswordWithRecovery(
      dto.identifier,
      dto.recoveryCode,
      dto.newPassword,
      res,
    );
  }

  /** Replace a password that was set for you. Unguarded by design: the caller
   *  cannot hold a session yet — that is the whole point of the flag — and the
   *  short-lived `changeToken` is the credential. */
  @Post('password/forced-change')
  forcedPasswordChange(
    @Body() dto: ForcedPasswordChangeDto,
    @Res({ passthrough: true }) res: express.Response,
  ) {
    return this.authService.changeForcedPassword(
      dto.changeToken,
      dto.newPassword,
      res,
      dto.email,
    );
  }

  @Post('2fa/resend')
  resendCode(@Body() dto: ResendCodeDto) {
    return this.authService.resendCode(dto.challenge);
  }

  /** Which sign-in methods this site offers. Public: the sign-in page needs it
   *  before anyone is signed in, and it carries nothing secret. */
  @Get('providers')
  providers() {
    return this.google.providers();
  }

  /** Sign in (or sign up) with a Google ID token. No emailed code: Google has
   *  already done its own second-factor check. */
  @Post('google')
  signInWithGoogle(
    @Body() dto: GoogleCredentialDto,
    @Res({ passthrough: true }) res: express.Response,
  ) {
    return this.google.signIn(dto.credential, res);
  }

  @Post('google/link')
  @UseGuards(JwtAuthGuard)
  linkGoogle(
    @Req() req: AuthenticatedRequest,
    @Body() dto: GoogleCredentialDto,
  ) {
    const userId = req.user.id || (req.user as any).sub;
    return this.google.link(userId, dto.credential);
  }

  @Delete('google/link')
  @UseGuards(JwtAuthGuard)
  unlinkGoogle(@Req() req: AuthenticatedRequest) {
    const userId = req.user.id || (req.user as any).sub;
    return this.google.unlink(userId);
  }

  @Get('signout')
  signout(@Res({ passthrough: true }) res: express.Response) {
    return this.authService.SignOut(res);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  getMe(@Req() req: AuthenticatedRequest) {
    const userId = req.user.id || (req.user as any).sub;
    return this.authService.getMe(userId);
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  updateMe(@Req() req: AuthenticatedRequest, @Body() dto: UpdateMeDto) {
    const userId = req.user.id || (req.user as any).sub;
    return this.authService.updateMe(userId, dto);
  }

  // ──────────────────────────────────────────────
  // ACCOUNT SETTINGS — the signed-in user's own account. Anything that could
  // hand the account to someone else needs proof (AccountService): an emailed
  // code when this site sends mail, else the current password.
  // ──────────────────────────────────────────────

  private static deviceToken(req: AuthenticatedRequest): string | undefined {
    return (req.cookies as Record<string, string | undefined>)?.['device'];
  }

  @Get('me/security')
  @UseGuards(JwtAuthGuard)
  accountSecurity(@Req() req: AuthenticatedRequest) {
    return this.account.security(req.user.id, AuthController.deviceToken(req));
  }

  @Post('me/code')
  @UseGuards(JwtAuthGuard)
  sendAccountCode(@Req() req: AuthenticatedRequest) {
    return this.account.sendCode(req.user.id);
  }

  /** Changing the password signs out everywhere else; this browser gets a
   *  replacement token in the response (and its cookie), so the person who made
   *  the change is not the one locked out. */
  @Post('me/password')
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @Req() req: AuthenticatedRequest,
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) res: express.Response,
  ) {
    const { user, ...result } = await this.account.changePassword(
      req.user.id,
      dto,
      AuthController.deviceToken(req),
    );
    const token = await this.authService.reissueSession(user, res);
    return { ...result, token };
  }

  @Post('me/sign-out-everywhere')
  @UseGuards(JwtAuthGuard)
  async signOutEverywhere(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: express.Response,
  ) {
    const result = await this.account.signOutEverywhere(req.user.id);
    res.clearCookie('token');
    res.clearCookie('device');
    return result;
  }

  @Post('me/email')
  @UseGuards(JwtAuthGuard)
  changeEmail(@Req() req: AuthenticatedRequest, @Body() dto: ChangeEmailDto) {
    return this.account.changeEmail(req.user.id, dto);
  }

  @Post('me/recovery-codes')
  @UseGuards(JwtAuthGuard)
  newRecoveryCodes(
    @Req() req: AuthenticatedRequest,
    @Body() dto: AccountProofDto,
  ) {
    return this.account.newRecoveryCodes(req.user.id, dto);
  }

  @Delete('me/devices/:id')
  @UseGuards(JwtAuthGuard)
  forgetDevice(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.account.forgetDevice(req.user.id, id);
  }

  /** POST, not DELETE: the proof travels in a body, which some proxies drop
   *  from DELETE requests. */
  @Post('me/delete')
  @UseGuards(JwtAuthGuard)
  async deleteMe(
    @Req() req: AuthenticatedRequest,
    @Body() dto: DeleteAccountDto,
    @Res({ passthrough: true }) res: express.Response,
  ) {
    const result = await this.account.deleteSelf(req.user.id, dto);
    res.clearCookie('token');
    res.clearCookie('device');
    return result;
  }

  // ──────────────────────────────────────────────
  // USER QUERIES
  // ──────────────────────────────────────────────

  @Get('users')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  getAllUsers() {
    return this.authService.getAllUsers();
  }

  @Get('registered-users')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  getRegisteredUsers() {
    return this.authService.getRegisteredUsers();
  }

  // ──────────────────────────────────────────────
  // GUEST MANAGEMENT
  // ──────────────────────────────────────────────

  @Audit({
    action: 'user.create_guest',
    category: AC.USER,
    pick: ['username'],
    describe: (c) => `Created the guest "${String(c.body.username ?? '')}"`,
  })
  @Post('createguest')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  createGuest(@Body('username') username: string) {
    return this.authService.CreateGuestUser(username);
  }

  // ITEM 2: Convert a guest to a registered account
  @Audit({
    action: 'user.convert_guest',
    category: AC.USER,
    targetUser: { param: 'id' },
    pick: ['username'],
    describe: (c) =>
      `Converted guest ${c.target} into the account @${String(c.body.username ?? '')}`,
  })
  @Patch('convert-guest/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  convertGuest(@Param('id') guestId: string, @Body() dto: ConvertGuestDto) {
    return this.authService.convertGuest(guestId, dto);
  }

  // ──────────────────────────────────────────────
  // ROLE MANAGEMENT
  // ──────────────────────────────────────────────

  @Audit({
    action: 'user.roles',
    category: AC.USER,
    targetUser: { param: 'id' },
    pick: ['roles'],
    describe: (c) =>
      `Set ${c.target}'s roles to ${((c.body.roles as string[]) ?? []).join(', ') || 'none'}`,
  })
  @Patch('roles/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  updateRoles(@Param('id') userId: string, @Body() dto: UpdateRolesDto) {
    return this.authService.updateRoles(userId, dto.roles);
  }

  // ──────────────────────────────────────────────
  // ADMIN — USER MANAGEMENT
  // ──────────────────────────────────────────────

  // ITEM 4: Admin manually creates a registered user
  @Audit({
    action: 'user.create',
    category: AC.USER,
    pick: ['username', 'roles'],
    describe: (c) => `Created the account @${String(c.body.username ?? '')}`,
  })
  @Post('users')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  adminCreateUser(@Body() dto: AdminCreateUserDto) {
    return this.authService.adminCreateUser(dto);
  }

  // ITEM 4: Admin edits a user's profile (username / email / password)
  @Audit({
    action: 'user.update_profile',
    category: AC.USER,
    targetUser: { param: 'id' },
    describe: (c) =>
      `Edited ${c.target}'s account (${c.fields.join(', ') || 'no changes'})`,
  })
  @Patch('users/:id/profile')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  updateProfile(@Param('id') targetId: string, @Body() dto: UpdateProfileDto) {
    return this.authService.updateProfile(targetId, dto);
  }

  // ITEM 1: Admin permanently deletes a user (preserves match history)
  @Audit({
    action: 'user.delete',
    category: AC.USER,
    targetUser: { param: 'id' },
    describe: (c) => `Deleted the account ${c.target}`,
  })
  @Delete('users/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  deleteUser(@Param('id') targetId: string) {
    return this.authService.deleteUser(targetId);
  }
}
