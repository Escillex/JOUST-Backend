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
import {
  AdminCreateUserDto,
  AuthDto,
  ConvertGuestDto,
  GoogleCredentialDto,
  RecoveryCodeDto,
  ResendCodeDto,
  SignUpDto,
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
  linkGoogle(@Req() req: AuthenticatedRequest, @Body() dto: GoogleCredentialDto) {
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
  updateMe(@Req() req: AuthenticatedRequest, @Body() dto: UpdateProfileDto) {
    const userId = req.user.id || (req.user as any).sub;
    return this.authService.updateMe(userId, dto);
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

  @Audit({ action: 'user.create_guest', category: AC.USER, pick: ['username'], describe: (c) => `Created the guest "${String(c.body.username ?? '')}"` })
  @Post('createguest')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  createGuest(@Body('username') username: string) {
    return this.authService.CreateGuestUser(username);
  }

  // ITEM 2: Convert a guest to a registered account
  @Audit({ action: 'user.convert_guest', category: AC.USER, targetUser: { param: 'id' }, pick: ['username'], describe: (c) => `Converted guest ${c.target} into the account @${String(c.body.username ?? '')}` })
  @Patch('convert-guest/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  convertGuest(@Param('id') guestId: string, @Body() dto: ConvertGuestDto) {
    return this.authService.convertGuest(guestId, dto);
  }

  // ──────────────────────────────────────────────
  // ROLE MANAGEMENT
  // ──────────────────────────────────────────────

  @Audit({ action: 'user.roles', category: AC.USER, targetUser: { param: 'id' }, pick: ['roles'], describe: (c) => `Set ${c.target}'s roles to ${((c.body.roles as string[]) ?? []).join(', ') || 'none'}` })
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
  @Audit({ action: 'user.create', category: AC.USER, pick: ['username', 'roles'], describe: (c) => `Created the account @${String(c.body.username ?? '')}` })
  @Post('users')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  adminCreateUser(@Body() dto: AdminCreateUserDto) {
    return this.authService.adminCreateUser(dto);
  }

  // ITEM 4: Admin edits a user's profile (username / email / password)
  @Audit({ action: 'user.update_profile', category: AC.USER, targetUser: { param: 'id' }, describe: (c) => `Edited ${c.target}'s account (${c.fields.join(', ') || 'no changes'})` })
  @Patch('users/:id/profile')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  updateProfile(@Param('id') targetId: string, @Body() dto: UpdateProfileDto) {
    return this.authService.updateProfile(targetId, dto);
  }

  // ITEM 1: Admin permanently deletes a user (preserves match history)
  @Audit({ action: 'user.delete', category: AC.USER, targetUser: { param: 'id' }, describe: (c) => `Deleted the account ${c.target}` })
  @Delete('users/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  deleteUser(@Param('id') targetId: string) {
    return this.authService.deleteUser(targetId);
  }
}
