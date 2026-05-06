import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import request from 'supertest';
import { TournamentController } from '../src/tournament/tournament.controller';
import { TournamentService } from '../src/tournament/tournament.service';
import { PrismaService } from '../prisma/prisma.service';
import { FormatsService } from '../src/Formats/formats.service';
import { JwtAuthGuard } from '../src/guards/jwt-auth.guard';
import { RolesGuard } from '../src/guards/roles.guard';
import { TournamentStatus, Role } from '@prisma/client';

describe('TournamentController (generate-bracket)', () => {
  let app: INestApplication;
  let prismaService: PrismaService;

  const mockUser = {
    id: 'user-id',
    email: 'organizer@example.com',
    roles: [Role.ORGANIZER],
  };

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [TournamentController],
      providers: [
        TournamentService,
        {
          provide: PrismaService,
          useValue: {
            tournament: {
              findUnique: jest.fn(),
            },
          },
        },
        {
          provide: FormatsService,
          useValue: {},
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          const req = context.switchToHttp().getRequest();
          req.user = mockUser;
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({
        canActivate: () => true,
      })
      .compile();

    app = moduleFixture.createNestApplication();
    prismaService = moduleFixture.get<PrismaService>(PrismaService);
    await app.init();
  });

  it('Returns preview with even participant count (no byes)', async () => {
    const tournamentId = '00000000-0000-0000-0000-000000000000';
    const participants = [
      { user: { id: 'p1', username: 'Player 1', isGuest: false }, seed: 1 },
      { user: { id: 'p2', username: 'Player 2', isGuest: false }, seed: 2 },
    ];

    jest.spyOn(prismaService.tournament, 'findUnique').mockResolvedValue({
      id: tournamentId,
      status: TournamentStatus.PENDING,
      createdById: mockUser.id,
      participants,
    } as any);

    const response = await request(app.getHttpServer())
      .post(`/tournaments/${tournamentId}/generate-bracket`)
      .expect(HttpStatus.OK);

    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toEqual({
      matchIndex: 1,
      player1: { id: 'p1', name: 'Player 1' },
      player2: { id: 'p2', name: 'Player 2' },
    });
  });

  it('Returns preview with odd participant count (has bye)', async () => {
    const tournamentId = '00000000-0000-0000-0000-000000000000';
    const participants = [
      { user: { id: 'p1', username: 'Player 1', isGuest: false }, seed: 1 },
      { user: { id: 'p2', username: 'Player 2', isGuest: false }, seed: 2 },
      { user: { id: 'p3', username: 'Player 3', isGuest: false }, seed: 3 },
    ];

    jest.spyOn(prismaService.tournament, 'findUnique').mockResolvedValue({
      id: tournamentId,
      status: TournamentStatus.PENDING,
      createdById: mockUser.id,
      participants,
    } as any);

    const response = await request(app.getHttpServer())
      .post(`/tournaments/${tournamentId}/generate-bracket`)
      .expect(HttpStatus.OK);

    expect(response.body).toHaveLength(2);
    expect(response.body[0]).toEqual({
        matchIndex: 1,
        player1: { id: 'p1', name: 'Player 1' },
        player2: { id: 'p2', name: 'Player 2' },
      });
    expect(response.body[1]).toEqual({
      matchIndex: 2,
      player1: { id: 'p3', name: 'Player 3' },
      player2: null,
    });
  });

  it('Returns 400 if tournament is already ONGOING', async () => {
    const tournamentId = '00000000-0000-0000-0000-000000000000';
    jest.spyOn(prismaService.tournament, 'findUnique').mockResolvedValue({
      id: tournamentId,
      status: TournamentStatus.ONGOING,
      createdById: mockUser.id,
      participants: [{}, {}],
    } as any);

    await request(app.getHttpServer())
      .post(`/tournaments/${tournamentId}/generate-bracket`)
      .expect(HttpStatus.BAD_REQUEST);
  });

  it('Returns 403 for non-organizer', async () => {
    const tournamentId = '00000000-0000-0000-0000-000000000000';
    jest.spyOn(prismaService.tournament, 'findUnique').mockResolvedValue({
      id: tournamentId,
      status: TournamentStatus.PENDING,
      createdById: 'other-user-id',
      participants: [{}, {}],
    } as any);

    await request(app.getHttpServer())
      .post(`/tournaments/${tournamentId}/generate-bracket`)
      .expect(HttpStatus.FORBIDDEN);
  });

  it('Returns 400 if fewer than 2 participants', async () => {
    const tournamentId = '00000000-0000-0000-0000-000000000000';
    jest.spyOn(prismaService.tournament, 'findUnique').mockResolvedValue({
      id: tournamentId,
      status: TournamentStatus.PENDING,
      createdById: mockUser.id,
      participants: [{ user: { id: 'p1', username: 'P1' } }],
    } as any);

    await request(app.getHttpServer())
      .post(`/tournaments/${tournamentId}/generate-bracket`)
      .expect(HttpStatus.BAD_REQUEST);
  });

  afterAll(async () => {
    await app.close();
  });
});
