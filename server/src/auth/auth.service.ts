import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { AuthDto } from './dto/auth.dto';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { isEmail } from './utils/check-input';
import { Response } from 'express';
import { Role } from '@prisma/client';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async SignUp(dto: AuthDto) {
    const { identifier, password } = dto;

    const isEmailUser = isEmail(identifier);
    const email = isEmailUser ? identifier : `user_${identifier}@example.com`;
    const username = isEmailUser ? identifier.split('@')[0] : identifier;

    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [{ email }, { username }],
      },
    });
    if (existingUser) {
      throw new BadRequestException('User already exists');
    }

    const hashedPassword = await this.hashPassword(password);

    await this.prisma.user.create({
      data: {
        email,
        username,
        hashedPassword,
        roles: [Role.PLAYER],
      },
    });

    return { message: 'You have Signed Up successfully' };
  }

  async SignIn(dto: AuthDto, res: Response) {
    const { identifier, password } = dto;

    const isEmailUser = isEmail(identifier);

    const foundUser = await this.prisma.user.findUnique({
      where: isEmailUser ? { email: identifier } : { username: identifier },
    });

    if (!foundUser) {
      throw new BadRequestException('User is not Registered');
    }

    const isPasswordValid = await this.verifyPassword(
      password,
      foundUser.hashedPassword,
    );
    if (!isPasswordValid) {
      throw new BadRequestException('Incorrect Password');
    }

    const token = await this.generateToken(
      foundUser.id,
      foundUser.email,
      foundUser.roles,
      foundUser.username,
    );

    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 3600000,
    });

    return {
      message: 'You have Signed In successfully',
      roles: foundUser.roles,
      token,
    };
  }

  SignOut(res: Response) {
    res.clearCookie('token');
    return { message: 'You have Signed Out successfully' };
  }

  async hashPassword(password: string) {
    const saltOrRounds = 10;
    return bcrypt.hash(password, saltOrRounds);
  }

  async verifyPassword(password: string, hashedPassword: string) {
    return bcrypt.compare(password, hashedPassword);
  }

  async generateToken(userId: string, email: string, roles: Role[], username: string) {
    const payload = { sub: userId, email, roles, username };
    return this.jwt.signAsync(payload);
  }

  // 👥 GET ALL USERS
  async getAllUsers() {
    return this.prisma.user.findMany({
      select: {
        id: true,
        username: true,
        email: true,
        roles: true,
      },
    });
  }

  // 👥 GET ONLY REGISTERED USERS (excluding guests)
  async getRegisteredUsers() {
    return this.prisma.user.findMany({
      where: {
        NOT: {
          email: {
            startsWith: 'guest_',
          },
        },
      },
      select: {
        id: true,
        username: true,
        email: true,
        roles: true,
      },
    });
  }

  // 🛡️ UPDATE USER ROLES
  async updateRoles(userId: string, roles: Role[]) {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        roles,
      },
      select: {
        id: true,
        username: true,
        roles: true,
      },
    });
  }

  // 👤 CREATE GUEST USER (for walk-ins)
  async CreateGuestUser(username: string) {
    const existing = await this.prisma.user.findUnique({
      where: { username },
    });

    if (existing) {
      throw new BadRequestException('A warrior with this name already exists');
    }

    // Generate a placeholder email and hash for the guest
    const guestId = Math.random().toString(36).substring(7);
    const email = `guest_${guestId}@joust.arena`;
    const hashedPassword = await this.hashPassword(`guest_pass_${guestId}`);

    return this.prisma.user.create({
      data: {
        username,
        email,
        hashedPassword,
        roles: [Role.PLAYER],
      },
      select: {
        id: true,
        username: true,
        email: true,
      },
    });
  }
}
