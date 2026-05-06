import { Test, TestingModule } from '@nestjs/testing';
import { FormatsService } from './formats.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MatchService } from '../tournament/match/match.service';
import { TournamentService } from '../tournament/tournament.service';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { TournamentFormat, MatchStatus, TournamentStatus } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';

describe('FormatsService', () => {
  let service: FormatsService;
  let prisma: PrismaService;
  let matchService: MatchService;
  let tournamentService: TournamentService;
  let leaderboardService: LeaderboardService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FormatsService,
        {
          provide: PrismaService,
          useValue: {
            round: { 
              create: jest.fn(),
              findUnique: jest.fn(),
            },
            match: { 
              create: jest.fn(), 
              update: jest.fn(), 
              findUnique: jest.fn(),
              findMany: jest.fn(),
            },
            tournament: { 
              update: jest.fn(),
              findUnique: jest.fn(),
            },
          },
        },
        {
          provide: MatchService,
          useValue: {
            createMatch: jest.fn(),
            activateMatch: jest.fn(),
            linkMatches: jest.fn(),
            advanceWinner: jest.fn(),
            advanceLoser: jest.fn(),
          },
        },
        {
          provide: TournamentService,
          useValue: {
            updateStatusInternal: jest.fn(),
          },
        },
        {
          provide: LeaderboardService,
          useValue: {
            getLeaderboard: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<FormatsService>(FormatsService);
    prisma = module.get<PrismaService>(PrismaService);
    matchService = module.get<MatchService>(MatchService);
    tournamentService = module.get<TournamentService>(TournamentService);
    leaderboardService = module.get<LeaderboardService>(LeaderboardService);

    jest.spyOn(prisma.match, 'findMany').mockResolvedValue([]);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('initializeTournamentFormat', () => {
    it('should throw BadRequestException for unsupported format', async () => {
      await expect(
        service.initializeTournamentFormat('t1', 'INVALID' as any, ['p1', 'p2']),
      ).rejects.toThrow(BadRequestException);
    });

    it('should initialize single elimination with even players', async () => {
      const tournamentId = 't1';
      const playerIds = ['p1', 'p2'];
      
      jest.spyOn(prisma.round, 'create').mockResolvedValue({ id: 'r1' } as any);
      jest.spyOn(matchService, 'createMatch').mockResolvedValue({ id: 'm1', player1Id: 'p1', player2Id: 'p2' } as any);

      await service.initializeTournamentFormat(tournamentId, TournamentFormat.SINGLE_ELIMINATION, playerIds);

      expect(prisma.round.create).toHaveBeenCalledWith({
        data: { tournamentId, roundNumber: 1 },
      });
      expect(matchService.createMatch).toHaveBeenCalled();
      expect(matchService.activateMatch).toHaveBeenCalledWith('m1');
    });

    it('should handle byes in single elimination', async () => {
      const tournamentId = 't1';
      const playerIds = ['p1']; // 1 player means next power of 2 is 1 (wait, nextPowerOfTwo(1) is 1, but generateBracket expects at least 2 for matches)
      // Actually nextPowerOfTwo(1) returns 1. 
      // If players.length is 1, loop current.length > 1 won't run.
      
      const playerIds3 = ['p1', 'p2', 'p3']; // Bracket size 4
      jest.spyOn(prisma.round, 'create').mockResolvedValue({ id: 'r1' } as any);
      jest.spyOn(matchService, 'createMatch').mockImplementation(async (dto) => ({
        id: Math.random().toString(),
        ...dto
      } as any));

      await service.initializeTournamentFormat(tournamentId, TournamentFormat.SINGLE_ELIMINATION, playerIds3);
      
      // Should have created 2 matches in round 1, and 1 match in round 2
      expect(prisma.round.create).toHaveBeenCalledTimes(2);
      expect(matchService.createMatch).toHaveBeenCalledTimes(3);
    });

    it('should initialize swiss format with even players', async () => {
      const tournamentId = 't1';
      const playerIds = ['p1', 'p2', 'p3', 'p4'];
      
      jest.spyOn(prisma.round, 'create').mockResolvedValue({ id: 'r1', roundNumber: 1 } as any);
      jest.spyOn(matchService, 'createMatch').mockImplementation(async (dto) => ({
        id: Math.random().toString(),
        ...dto
      } as any));

      await service.initializeTournamentFormat(tournamentId, TournamentFormat.SWISS, playerIds);

      expect(prisma.round.create).toHaveBeenCalledWith({
        data: { tournamentId, roundNumber: 1 },
      });
      expect(matchService.createMatch).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleMatchCompletion', () => {
    it('should advance winner in single elimination', async () => {
      const matchId = 'm1';
      const winnerId = 'p1';
      const nextMatchId = 'm2';
      
      jest.spyOn(prisma.match, 'findUnique').mockResolvedValue({
        id: matchId,
        winnerId,
        nextMatchId,
        round: {
          tournament: {
            id: 't1',
            format: TournamentFormat.SINGLE_ELIMINATION,
          }
        }
      } as any);

      await service.handleMatchCompletion(matchId);

      expect(matchService.advanceWinner).toHaveBeenCalledWith(winnerId, nextMatchId);
    });

    it('should complete tournament if single elimination final is done', async () => {
        const matchId = 'm_final';
        const winnerId = 'p1';
        
        jest.spyOn(prisma.match, 'findUnique').mockResolvedValue({
          id: matchId,
          winnerId,
          nextMatchId: null,
          roundId: 'r_final',
          round: {
            tournament: {
              id: 't1',
              format: TournamentFormat.SINGLE_ELIMINATION,
            }
          }
        } as any);

        jest.spyOn(prisma.round, 'findUnique').mockResolvedValue({
            id: 'r_final',
            matches: [{ id: matchId, status: MatchStatus.COMPLETED, winnerId, nextMatchId: null }]
        } as any);

        await service.handleMatchCompletion(matchId);

        expect(tournamentService.updateStatusInternal).toHaveBeenCalledWith('t1', TournamentStatus.COMPLETED);
        expect(prisma.tournament.update).toHaveBeenCalledWith({
            where: { id: 't1' },
            data: { winnerId }
        });
      });
  });
});
