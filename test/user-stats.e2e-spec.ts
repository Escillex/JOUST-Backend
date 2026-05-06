import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { UserModule } from '../src/user/user.module';
import { PrismaService } from '../prisma/prisma.service';
import { MatchStatus } from '@prisma/client';

describe('UserController (e2e) - User Stats', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const mockUuid = '00000000-0000-0000-0000-000000000000';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [UserModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
    prisma = moduleFixture.get<PrismaService>(PrismaService);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('Returns 400 if :id is not a valid format', async () => {
    await request(app.getHttpServer())
      .get('/users/invalid-id/stats')
      .expect(HttpStatus.BAD_REQUEST);
  });

  it('Returns 404 for unknown user ID', async () => {
    jest.spyOn(prisma.user, 'findUnique').mockResolvedValue(null);

    await request(app.getHttpServer())
      .get(`/users/${mockUuid}/stats`)
      .expect(HttpStatus.NOT_FOUND);
  });

  it('Returns correct wins/losses for a user with match history', async () => {
    const userId = mockUuid;
    jest.spyOn(prisma.user, 'findUnique').mockResolvedValue({ id: userId } as any);
    jest.spyOn(prisma.match, 'count')
      .mockResolvedValueOnce(10) // wins
      .mockResolvedValueOnce(5); // losses
    jest.spyOn(prisma.tournamentParticipant, 'count').mockResolvedValue(3);
    jest.spyOn(prisma.match, 'groupBy').mockResolvedValue([]); // rank 1

    const response = await request(app.getHttpServer())
      .get(`/users/${userId}/stats`)
      .expect(HttpStatus.OK);

    expect(response.body).toEqual({
      userId,
      wins: 10,
      losses: 5,
      winRate: 10 / 15,
      tournamentsPlayed: 3,
      rank: 1,
    });
  });

  it('winRate is 0 when user has no matches', async () => {
    const userId = mockUuid;
    jest.spyOn(prisma.user, 'findUnique').mockResolvedValue({ id: userId } as any);
    jest.spyOn(prisma.match, 'count')
      .mockResolvedValueOnce(0) // wins
      .mockResolvedValueOnce(0); // losses
    jest.spyOn(prisma.tournamentParticipant, 'count').mockResolvedValue(0);
    // Rank won't be calculated if wins+losses === 0

    const response = await request(app.getHttpServer())
      .get(`/users/${userId}/stats`)
      .expect(HttpStatus.OK);

    expect(response.body.winRate).toBe(0);
    expect(response.body.rank).toBe(null);
  });

  it('rank is 1 for the user with the most wins', async () => {
    const userId = mockUuid;
    jest.spyOn(prisma.user, 'findUnique').mockResolvedValue({ id: userId } as any);
    jest.spyOn(prisma.match, 'count')
      .mockResolvedValueOnce(100) // wins
      .mockResolvedValueOnce(0); // losses
    jest.spyOn(prisma.tournamentParticipant, 'count').mockResolvedValue(10);
    jest.spyOn(prisma.match, 'groupBy').mockResolvedValue([]); // No users with more than 100 wins

    const response = await request(app.getHttpServer())
      .get(`/users/${userId}/stats`)
      .expect(HttpStatus.OK);

    expect(response.body.rank).toBe(1);
  });

  it('rank is computed correctly based on other users wins', async () => {
    const userId = mockUuid;
    jest.spyOn(prisma.user, 'findUnique').mockResolvedValue({ id: userId } as any);
    jest.spyOn(prisma.match, 'count')
      .mockResolvedValueOnce(5) // wins
      .mockResolvedValueOnce(5); // losses
    jest.spyOn(prisma.tournamentParticipant, 'count').mockResolvedValue(2);
    // 2 users have more than 5 wins
    jest.spyOn(prisma.match, 'groupBy').mockResolvedValue([
        { winnerId: 'userA', _count: { winnerId: 10 } },
        { winnerId: 'userB', _count: { winnerId: 8 } }
    ] as any);

    const response = await request(app.getHttpServer())
      .get(`/users/${userId}/stats`)
      .expect(HttpStatus.OK);

    expect(response.body.rank).toBe(3);
  });
});
