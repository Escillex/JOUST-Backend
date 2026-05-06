import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import {
  AuthDto,
  AdminCreateUserDto,
  ConvertGuestDto,
  UpdateProfileDto,
} from './dto/auth.dto';
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

  // ──────────────────────────────────────────────
  // CRON: Cleanup orphaned guests every midnight
  // ──────────────────────────────────────────────
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleGuestCleanup() {
    const now = new Date();
    
    // Mark expired guests
    await this.prisma.user.updateMany({
      where: {
        isGuest: true,
        isExpired: false,
        expiresAt: { lt: now },
      },
      data: { isExpired: true },
    });

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // Find guests older than 7 days who only have participations in COMPLETED tournaments
    const staleGuests = await this.prisma.user.findMany({
      where: {
        isGuest: true,
        createdAt: { lt: sevenDaysAgo },
        participatedTournaments: {
          every: {
            tournament: { status: 'COMPLETED' },
          },
        },
      },
      select: { id: true },
    });

    if (staleGuests.length > 0) {
      for (const guest of staleGuests) {
        await this.deleteUser(guest.id);
      }
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async handleHourlyExpiryCheck() {
    const now = new Date();
    await this.prisma.user.updateMany({
      where: {
        isGuest: true,
        isExpired: false,
        expiresAt: { lt: now },
      },
      data: { isExpired: true },
    });
  }

  // ──────────────────────────────────────────────
  // PURGE EXPIRED GUESTS (Triggered by Admin/Organizer actions)
  // ──────────────────────────────────────────────
  async purgeExpiredGuests() {
    const now = new Date();
    const expired = await this.prisma.user.findMany({
      where: {
        isGuest: true,
        OR: [
          { isExpired: true },
          { expiresAt: { lt: now } }
        ]
      },
      select: { id: true }
    });

    for (const user of expired) {
      try {
        await this.deleteUser(user.id);
      } catch (err) {
        // Silently skip if already gone or locked
      }
    }
  }

  // ──────────────────────────────────────────────
  // SIGN UP
  // ──────────────────────────────────────────────
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

  // ──────────────────────────────────────────────
  // SIGN IN
  // ──────────────────────────────────────────────
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

  // ──────────────────────────────────────────────
  // SIGN OUT
  // ──────────────────────────────────────────────
  SignOut(res: Response) {
    res.clearCookie('token');
    return { message: 'You have Signed Out successfully' };
  }

  // ──────────────────────────────────────────────
  // HELPERS
  // ──────────────────────────────────────────────
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

  // ──────────────────────────────────────────────
  // GET ALL USERS
  // ──────────────────────────────────────────────
  async getAllUsers() {
    await this.purgeExpiredGuests(); // Cleanup before returning list to admin/organizer
    return this.prisma.user.findMany({
      select: {
        id: true,
        username: true,
        email: true,
        roles: true,
        isGuest: true,
        expiresAt: true,
        isExpired: true,
      },
    });
  }

  // ──────────────────────────────────────────────
  // GET ONLY REGISTERED USERS (excluding guests)
  // ──────────────────────────────────────────────
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

  // ──────────────────────────────────────────────
  // UPDATE USER ROLES
  // ──────────────────────────────────────────────
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

  // ──────────────────────────────────────────────
  // CREATE GUEST USER (for walk-ins)
  // ──────────────────────────────────────────────
  async CreateGuestUser(username: string) {
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24); // 24-hour lifespan by default

    return this.prisma.user.create({
      data: {
        isGuest: true,
        username,
        roles: [Role.PLAYER],
        expiresAt,
      },
      select: {
        id: true,
        username: true,
        isGuest: true,
        expiresAt: true,
      },
    });
  }

  // ──────────────────────────────────────────────
  // ITEM 1: DELETE USER (Admin) — preserves match history
  // ──────────────────────────────────────────────
  async deleteUser(targetId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetId },
    });
    if (!user) throw new NotFoundException('User not found');

    const displayName = user.username ?? 'Unknown Pilot';

    // Step 1: Burn name into any match where they were player1
    await this.prisma.match.updateMany({
      where: { player1Id: targetId },
      data: { p1Name: displayName, player1Id: null },
    });

    // Step 2: Burn name into any match where they were player2
    await this.prisma.match.updateMany({
      where: { player2Id: targetId },
      data: { p2Name: displayName, player2Id: null },
    });

    // Step 3: Burn name into any match where they were the winner
    await this.prisma.match.updateMany({
      where: { winnerId: targetId },
      data: { winnerName: displayName, winnerId: null },
    });

    // Step 4: Burn name into any tournament where they were the winner
    await this.prisma.tournament.updateMany({
      where: { winnerId: targetId },
      data: { winnerName: displayName, winnerId: null } as any,
    });

    // Step 5: Handle tournaments they created (if any)
    await this.prisma.tournament.updateMany({
      where: { createdById: targetId },
      data: { createdById: null } as any,
    });

    // Step 6: Remove all tournament participations
    await this.prisma.tournamentParticipant.deleteMany({
      where: { userId: targetId },
    });

    // Step 7: Delete the user
    await this.prisma.user.delete({ where: { id: targetId } });

    return { message: `Pilot "${displayName}" has been permanently removed.` };
  }

  // ──────────────────────────────────────────────
  // ITEM 2: CONVERT GUEST TO REGISTERED PILOT
  // ──────────────────────────────────────────────
  async convertGuest(guestId: string, dto: ConvertGuestDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: guestId },
    });
    if (!user) throw new NotFoundException('User not found');
    if (!user.isGuest)
      throw new BadRequestException('User is already a registered pilot');

    // Check for conflicts
    const conflict = await this.prisma.user.findFirst({
      where: {
        id: { not: guestId },
        OR: [{ email: dto.email }, { username: dto.username }],
      },
    });
    if (conflict) {
      throw new BadRequestException('Username or email already taken');
    }

    const hashedPassword = await this.hashPassword(dto.password);

    const upgraded = await this.prisma.user.update({
      where: { id: guestId },
      data: {
        username: dto.username,
        email: dto.email,
        hashedPassword,
        isGuest: false,
      },
      select: { id: true, username: true, email: true, roles: true },
    });

    return { message: 'Guest successfully converted to registered pilot', user: upgraded };
  }

  // ──────────────────────────────────────────────
  // ITEM 4: ADMIN — UPDATE USER PROFILE
  // ──────────────────────────────────────────────
  async updateProfile(targetId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!user) throw new NotFoundException('User not found');

    // Check for email/username conflicts
    if (dto.email || dto.username) {
      const conflict = await this.prisma.user.findFirst({
        where: {
          id: { not: targetId },
          OR: [
            ...(dto.email ? [{ email: dto.email }] : []),
            ...(dto.username ? [{ username: dto.username }] : []),
          ],
        },
      });
      if (conflict) {
        throw new BadRequestException('Username or email already taken');
      }
    }

    const data: Record<string, unknown> = {};
    if (dto.username) data.username = dto.username;
    if (dto.email) data.email = dto.email;
    if (dto.password) data.hashedPassword = await this.hashPassword(dto.password);

    const updated = await this.prisma.user.update({
      where: { id: targetId },
      data,
      select: { id: true, username: true, email: true, roles: true },
    });

    return { message: 'Profile updated', user: updated };
  }

  // ──────────────────────────────────────────────
  // ITEM 4: ADMIN — CREATE USER MANUALLY
  // ──────────────────────────────────────────────
  async adminCreateUser(dto: AdminCreateUserDto) {
    const conflict = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: dto.email }, { username: dto.username }],
      },
    });
    if (conflict) throw new BadRequestException('Username or email already exists');

    const hashedPassword = await this.hashPassword(dto.password);

    const created = await this.prisma.user.create({
      data: {
        username: dto.username,
        email: dto.email,
        hashedPassword,
        roles: dto.roles && dto.roles.length > 0 ? dto.roles : [Role.PLAYER],
        isGuest: false,
      },
      select: { id: true, username: true, email: true, roles: true },
    });

    return { message: 'Pilot account created', user: created };
  }
}

