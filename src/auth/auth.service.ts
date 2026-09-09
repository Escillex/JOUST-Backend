import { sessionCookieOptions } from '../config/security.config';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { generateUniqueUserSlug } from '../user/user-slug.util';
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
import { Role, ParticipantStatus, TournamentStatus } from '@prisma/client';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  // Scheduled guest cleanup used to live here as two crons (midnight + hourly),
  // duplicating two more in jobs/cleanGuests.ts. All four were consolidated into
  // the single hourly CleanGuestsJob, which calls deleteUser() below for the
  // stale-guest phase so name-burning still happens.

  // ──────────────────────────────────────────────
  // PURGE EXPIRED GUESTS (Triggered by Admin/Organizer actions)
  // ──────────────────────────────────────────────
  async purgeExpiredGuests() {
    const now = new Date();
    const expired = await this.prisma.user.findMany({
      where: {
        isGuest: true,
        OR: [{ isExpired: true }, { expiresAt: { lt: now } }],
      },
      select: { id: true },
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

    const slug = await generateUniqueUserSlug(this.prisma, username);
    await this.prisma.user.create({
      data: {
        email,
        username,
        slug,
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
      foundUser.avatarUrl,
    );

    // `secure` is env-driven (7.6): hardcoding false shipped the session cookie
    // over plain http in production. sameSite stays 'lax' — it is what stops a
    // cross-site socket handshake carrying this cookie (see realtime.gateway).
    res.cookie('token', token, sessionCookieOptions(3600000));

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

  async updateMe(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (dto.email || dto.username) {
      const conflict = await this.prisma.user.findFirst({
        where: {
          id: { not: userId },
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

    const data: Record<string, any> = {};
    if (dto.username) data.username = dto.username;
    if (dto.email) data.email = dto.email;
    if (dto.password)
      data.hashedPassword = await this.hashPassword(dto.password);

    return this.prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        username: true,
        email: true,
        roles: true,
        avatarUrl: true,
      },
    });
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

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        slug: true,
        email: true,
        roles: true,
        isGuest: true,
        avatarUrl: true,
        createdAt: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async generateToken(
    userId: string,
    email: string | null,
    roles: Role[],
    username: string | null,
    avatarUrl?: string | null,
  ) {
    const payload = { id: userId, email, roles, username, avatarUrl };
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

    const slug = await generateUniqueUserSlug(this.prisma, username);
    return this.prisma.user.create({
      data: {
        isGuest: true,
        username,
        slug,
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

    // F6. Refuse to delete someone still active in a live tournament. Deleting
    // them would null their pending match slots with no walkover, stalling the
    // opponent and the bracket. The organizer must forfeit them first (which
    // awards their pending matches to opponents), then the account can go. A
    // FORFEITED participant is fine — they have already been walked over.
    const liveParticipation = await this.prisma.tournamentParticipant.findMany({
      where: {
        userId: targetId,
        status: { not: ParticipantStatus.FORFEITED },
        tournament: {
          status: {
            in: [TournamentStatus.OPEN, TournamentStatus.ONGOING],
          },
        },
      },
      select: { tournamentId: true, tournament: { select: { name: true } } },
    });
    if (liveParticipation.length > 0) {
      // Structured payload so the admin UI can offer a forfeit-then-delete flow:
      // it lists the live tournaments to forfeit the user from before retrying.
      throw new BadRequestException({
        code: 'ACTIVE_IN_LIVE_TOURNAMENT',
        message:
          `This user is an active participant in ${liveParticipation.length} live ` +
          `tournament(s). Forfeit them first, then delete the account.`,
        tournaments: liveParticipation.map((p) => ({
          id: p.tournamentId,
          name: p.tournament.name,
        })),
      });
    }

    const displayName = user.username ?? 'Deleted player';

    // All seven steps run as one transaction. The whole point of the ordering is
    // that steps 1-6 preserve this player's name in finished brackets before
    // step 7 destroys the account it came from. Half-applied, it produces
    // matches showing a name with a null player id while the account still
    // exists - a user who is a ghost in their own match history. Every step is a
    // plain database write, so there is nothing that needs to happen outside.
    await this.prisma.$transaction(async (tx) => {
      // Step 1: Burn name into any match where they were player1
      await tx.match.updateMany({
        where: { player1Id: targetId },
        data: { p1Name: displayName, player1Id: null },
      });

      // Step 2: Burn name into any match where they were player2
      await tx.match.updateMany({
        where: { player2Id: targetId },
        data: { p2Name: displayName, player2Id: null },
      });

      // Step 3: Burn name into any match where they were the winner
      await tx.match.updateMany({
        where: { winnerId: targetId },
        data: { winnerName: displayName, winnerId: null },
      });

      // Step 4: Burn name into any tournament where they were the winner
      await tx.tournament.updateMany({
        where: { winnerId: targetId },
        data: { winnerName: displayName, winnerId: null } as any,
      });

      // Step 5: Handle tournaments they created (if any)
      await tx.tournament.updateMany({
        where: { createdById: targetId },
        data: { createdById: null } as any,
      });

      // Step 6: Remove all tournament participations
      await tx.tournamentParticipant.deleteMany({
        where: { userId: targetId },
      });

      // Step 7: Delete the user
      await tx.user.delete({ where: { id: targetId } });
    });

    return { message: `"${displayName}" has been permanently removed.` };
  }

  // ──────────────────────────────────────────────
  // ITEM 2: CONVERT GUEST TO A REGISTERED ACCOUNT
  // ──────────────────────────────────────────────
  async convertGuest(guestId: string, dto: ConvertGuestDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: guestId },
    });
    if (!user) throw new NotFoundException('User not found');
    if (!user.isGuest)
      throw new BadRequestException('User already has a registered account');

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

    return {
      message: 'Guest successfully converted to a registered account',
      user: upgraded,
    };
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
    if (dto.password)
      data.hashedPassword = await this.hashPassword(dto.password);

    // Re-derive the profile handle when the username actually changes. Old links
    // still resolve via the UUID path, so a rename never 404s a shared link — it
    // just makes the pretty handle match the new name.
    if (dto.username && dto.username !== user.username) {
      data.slug = await generateUniqueUserSlug(
        this.prisma,
        dto.username,
        targetId,
      );
    }

    const updated = await this.prisma.user.update({
      where: { id: targetId },
      data,
      select: { id: true, username: true, email: true, roles: true, slug: true },
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
    if (conflict)
      throw new BadRequestException('Username or email already exists');

    const hashedPassword = await this.hashPassword(dto.password);

    const slug = await generateUniqueUserSlug(this.prisma, dto.username);
    const created = await this.prisma.user.create({
      data: {
        username: dto.username,
        email: dto.email,
        slug,
        hashedPassword,
        roles: dto.roles && dto.roles.length > 0 ? dto.roles : [Role.PLAYER],
        isGuest: false,
      },
      select: { id: true, username: true, email: true, roles: true },
    });

    return { message: 'Account created', user: created };
  }
}
