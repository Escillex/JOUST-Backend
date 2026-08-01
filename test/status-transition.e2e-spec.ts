import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus, ValidationPipe } from '@nestjs/common';
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

describe('TournamentController (status transitions)', () => {
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
              update: jest.fn(),
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
          // TournamentService now broadcasts a refresh on status changes; the
          // gateway is stubbed so the test does not need a live socket server.
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
    app.useGlobalPipes(new ValidationPipe());
    prismaService = moduleFixture.get<PrismaService>(PrismaService);
    await app.init();
  });

  it('Organizer can transition PENDING → OPEN', async () => {
    const tournamentId = '00000000-0000-0000-0000-000000000000';
    jest.spyOn(prismaService.tournament, 'findUnique').mockResolvedValue({
      id: tournamentId,
      status: TournamentStatus.PENDING,
      createdById: mockUser.id,
    } as any);

    jest.spyOn(prismaService.tournament, 'update').mockResolvedValue({
      id: tournamentId,
      status: TournamentStatus.OPEN,
    } as any);

    const response = await request(app.getHttpServer())
      .patch(`/tournaments/${tournamentId}/status`)
      .send({ status: TournamentStatus.OPEN })
      .expect(HttpStatus.OK);

    expect(response.body.status).toBe(TournamentStatus.OPEN);
  });

  it('Non-organizer gets 403', async () => {
    const tournamentId = '00000000-0000-0000-0000-000000000000';
    jest.spyOn(prismaService.tournament, 'findUnique').mockResolvedValue({
      id: tournamentId,
      status: TournamentStatus.PENDING,
      createdById: 'other-user-id',
    } as any);

    await request(app.getHttpServer())
      .patch(`/tournaments/${tournamentId}/status`)
      .send({ status: TournamentStatus.OPEN })
      .expect(HttpStatus.FORBIDDEN);
  });

  it('Invalid transition (e.g. PENDING → COMPLETED) gets 400', async () => {
    const tournamentId = '00000000-0000-0000-0000-000000000000';
    jest.spyOn(prismaService.tournament, 'findUnique').mockResolvedValue({
      id: tournamentId,
      status: TournamentStatus.PENDING,
      createdById: mockUser.id,
    } as any);

    await request(app.getHttpServer())
      .patch(`/tournaments/${tournamentId}/status`)
      .send({ status: TournamentStatus.COMPLETED })
      .expect(HttpStatus.BAD_REQUEST);
  });

  it('Missing status body gets 400', async () => {
    const tournamentId = '00000000-0000-0000-0000-000000000000';
    // The tournament has to exist and be owned by the caller for the request to
    // reach validation at all: TournamentAccessGuard runs before the pipes, so an
    // unmocked lookup would 404 first.
    jest.spyOn(prismaService.tournament, 'findUnique').mockResolvedValue({
      id: tournamentId,
      status: TournamentStatus.PENDING,
      createdById: mockUser.id,
    } as any);

    await request(app.getHttpServer())
      .patch(`/tournaments/${tournamentId}/status`)
      .send({})
      .expect(HttpStatus.BAD_REQUEST);
  });

  afterAll(async () => {
    await app.close();
  });
});
