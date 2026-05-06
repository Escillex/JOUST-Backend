import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { AuthDto } from './dto/auth.dto';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { isEmail } from './utils/check-input';
import { Response } from 'express';
import { Role } from '@prisma/client';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleGuestCleanup() {
    const orphanedGuests = await this.prisma.user.findMany({
      where: {
        isGuest: true,
        participatedTournaments: {
          none: {},
        },
      },
    });

    if (orphanedGuests.length > 0) {
      await this.prisma.user.deleteMany({
        where: {
          id: { in: orphanedGuests.map((u) => u.id) },
        },
      });
    }
  }

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

    if (!foundUser.hashedPassword) {
      throw new UnauthorizedException('Invalid credentials');
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

  async generateToken(
    userId: string,
    email: string | null,
    roles: Role[],
    username: string | null,
  ) {
    const payload = { id: userId, email, roles, username };
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
        isGuest: false,
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
    return this.prisma.user.create({
      data: {
        isGuest: true,
        guestName: username,
        roles: [Role.PLAYER],
      },
      select: {
        id: true,
        guestName: true,
        isGuest: true,
      },
    });
  }
}
