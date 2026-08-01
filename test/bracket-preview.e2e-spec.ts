import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import request from 'supertest';
import { TournamentController } from '../src/tournament/tournament.controller';
import { TournamentService } from '../src/tournament/tournament.service';
import { PrismaService } from '../prisma/prisma.service';
import { FormatsService } from '../src/Formats/formats.service';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service';
import { JwtAuthGuard } from '../src/guards/jwt-auth.guard';
import { RolesGuard } from '../src/guards/roles.guard';
import { RealtimeGateway } from '../src/realtime/realtime.gateway';
import { JwtService } from '@nestjs/jwt';
import { NotificationService } from '../src/notification/notification.service';
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
            tournamentOrganizer: {
              findUnique: jest.fn().mockResolvedValue(null),
            },
            tournament: {
              findUnique: jest.fn(),
            },
          },
        },
        {
          provide: FormatsService,
          useValue: {},
        },
        {
          provide: LeaderboardService,
          useValue: {},
        },
        {
          // TournamentService depends on the gateway; stub it so no live
          // socket server is needed for this preview-only test.
          provide: RealtimeGateway,
          useValue: {
            emitTournamentUpdated: jest.fn(),
            emitTrackerUpdate: jest.fn(),
          },
        },
        {
          // TournamentService writes notifications on status changes; stubbed so
          // this suite does not need a database or a socket server.
          provide: NotificationService,
          useValue: { notify: jest.fn(), notifyMany: jest.fn() },
        },
        {
          // The controller's public GET now carries OptionalJwtAuthGuard so it can
          // report canManage. These tests never exercise that route, but Nest still
          // has to resolve the guard's JwtService when the module is built.
          provide: JwtService,
          useValue: { verifyAsync: jest.fn() },
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

  it('Returns preview with odd participant count, giving the bye to the top seed', async () => {
    // This previously expected p1 vs p2 in match 1 and a bye for p3 — adjacent
    // pairing, which gave the free pass to the WORST seed and sat the top two
    // seeds against each other immediately. Standard seeding puts the bye on
    // seed 1 and pairs 2 against 3.
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
      player2: null,
    });
    expect(response.body[1]).toEqual({
      matchIndex: 2,
      player1: { id: 'p2', name: 'Player 2' },
      player2: { id: 'p3', name: 'Player 3' },
    });
  });

  it('Seeds an 8-player bracket so the top two seeds meet only in the final', async () => {
    const tournamentId = '00000000-0000-0000-0000-000000000000';
    const participants = Array.from({ length: 8 }, (_, i) => ({
      user: { id: `p${i + 1}`, username: `Player ${i + 1}`, isGuest: false },
      seed: i + 1,
    }));

    jest.spyOn(prismaService.tournament, 'findUnique').mockResolvedValue({
      id: tournamentId,
      status: TournamentStatus.PENDING,
      createdById: mockUser.id,
      participants,
    } as any);

    const response = await request(app.getHttpServer())
      .post(`/tournaments/${tournamentId}/generate-bracket`)
      .expect(HttpStatus.OK);

    const pairs = response.body.map(
      (m: any) => `${m.player1?.name ?? '-'} vs ${m.player2?.name ?? '-'}`,
    );
    expect(pairs).toEqual([
      'Player 1 vs Player 8',
      'Player 4 vs Player 5',
      'Player 2 vs Player 7',
      'Player 3 vs Player 6',
    ]);
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
