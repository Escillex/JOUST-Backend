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
import { AuthDto, UpdateRolesDto } from './dto/auth.dto';
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
    return req.user;
  }

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

  @Patch('roles/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  updateRoles(@Param('id') userId: string, @Body() dto: UpdateRolesDto) {
    return this.authService.updateRoles(userId, dto.roles);
  }

  @Post('createguest')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMIN)
  createGuest(@Body('username') username: string) {
    return this.authService.CreateGuestUser(username);
  }

  @Delete('delete')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  DeleteMe(@Req() req: AuthenticatedRequest) {
    console.log(req.user);
    return 'Test Delete';
  }
}
