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
import {
  AuthDto,
  UpdateRolesDto,
  ConvertGuestDto,
  UpdateProfileDto,
  AdminCreateUserDto,
} from './dto/auth.dto';
import * as express from 'express';
import {
  JwtAuthGuard,
  type AuthenticatedRequest,
} from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../guards/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ──────────────────────────────────────────────
  // PUBLIC AUTH
  // ──────────────────────────────────────────────

  @Post('signup')
  signup(@Body() dto: AuthDto) {
    return this.authService.SignUp(dto);
  }

  @Post('signin')
  signin(
    @Body() dto: AuthDto,
    @Res({ passthrough: true }) res: express.Response,
  ) {
    return this.authService.SignIn(dto, res);
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

  @Post('createguest')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  createGuest(@Body('username') username: string) {
    return this.authService.CreateGuestUser(username);
  }

  // ITEM 2: Convert a guest to a registered pilot
  @Patch('convert-guest/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  convertGuest(@Param('id') guestId: string, @Body() dto: ConvertGuestDto) {
    return this.authService.convertGuest(guestId, dto);
  }

  // ──────────────────────────────────────────────
  // ROLE MANAGEMENT
  // ──────────────────────────────────────────────

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
  @Post('users')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  adminCreateUser(@Body() dto: AdminCreateUserDto) {
    return this.authService.adminCreateUser(dto);
  }

  // ITEM 4: Admin edits a user's profile (username / email / password)
  @Patch('users/:id/profile')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  updateProfile(
    @Param('id') targetId: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.authService.updateProfile(targetId, dto);
  }

  // ITEM 1: Admin permanently deletes a user (preserves match history)
  @Delete('users/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  deleteUser(@Param('id') targetId: string) {
    return this.authService.deleteUser(targetId);
  }
}
