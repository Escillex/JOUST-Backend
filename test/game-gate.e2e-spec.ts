import { BadRequestException } from '@nestjs/common';
import { TournamentService } from '../src/tournament/tournament.service';
import { GameService } from '../src/game/game.service';

// Games are first-class taxonomy (todo.md §5), and there is deliberately no
// fallback game any more. The retired built-in "General" let every tournament
// claim a game without naming one, which pooled every per-game leaderboard into
// one meaningless bucket. These tests pin the gate that replaced it: a tournament
// names a real game, or it is not created.
describe('game assignment gate', () => {
  const GENERAL = { id: 'g-general', name: 'General', isBuiltin: true };
  const CHESS = { id: 'g-chess', name: 'Chess', isBuiltin: false };

  const buildGameService = (game: any) => {
    const prisma = {
      game: { findUnique: jest.fn().mockResolvedValue(game) },
    } as any;
    return new GameService(prisma, { notifyAdmins: jest.fn() } as any);
  };

  describe('GameService.assertAssignable', () => {
    it('accepts a catalog game', async () => {
      await expect(
        buildGameService(CHESS).assertAssignable('g-chess'),
      ).resolves.toEqual(CHESS);
    });

    it('rejects the retired system placeholder', async () => {
      await expect(
        buildGameService(GENERAL).assertAssignable('g-general'),
      ).rejects.toMatchObject({
        response: { code: 'GAME_NOT_ASSIGNABLE' },
      });
    });

    it('rejects an unknown game', async () => {
      await expect(
        buildGameService(null).assertAssignable('nope'),
      ).rejects.toMatchObject({ response: { code: 'GAME_NOT_FOUND' } });
    });
  });

  describe('createTournament', () => {
    // assignableCount is what the catalog holds MINUS retired rows, which is the
    // difference between "you forgot to pick" and "there is nothing to pick".
    const buildService = (opts: {
      formatGameId?: string | null;
      assignableCount?: number;
    }) => {
      const prisma = {
        tournament: {
          findFirst: jest.fn().mockResolvedValue(null),
          // Slug generation probes for collisions before the create.
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({ id: 't1' }),
        },
        tournamentFormat: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: 'f1', gameId: opts.formatGameId ?? null }),
        },
        game: {
          count: jest.fn().mockResolvedValue(opts.assignableCount ?? 1),
        },
      } as any;
      const games = { assertAssignable: jest.fn().mockResolvedValue(CHESS) };
      const service = new TournamentService(
        prisma,
        {} as any,
        {} as any,
        {} as any,
        { notify: jest.fn(), notifyMany: jest.fn() } as any,
        games as any,
      );
      return { prisma, games, service };
    };

    const dto = { name: 'Cup', formatId: 'f1', maxPlayers: 4 } as any;

    it('refuses with NO_GAMES_CONFIGURED when the catalog is empty', async () => {
      const { service, prisma } = buildService({ assignableCount: 0 });
      await expect(service.createTournament(dto, 'u1')).rejects.toMatchObject({
        response: { code: 'NO_GAMES_CONFIGURED' },
      });
      expect(prisma.tournament.create).not.toHaveBeenCalled();
    });

    it('refuses with NO_GAME_SELECTED when games exist but none was chosen', async () => {
      const { service } = buildService({ assignableCount: 3 });
      await expect(service.createTournament(dto, 'u1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.createTournament(dto, 'u1')).rejects.toMatchObject({
        response: { code: 'NO_GAME_SELECTED' },
      });
    });

    it("falls back to the format's default game, and validates it", async () => {
      const { service, games, prisma } = buildService({
        formatGameId: 'g-chess',
      });
      await service.createTournament(dto, 'u1');
      expect(games.assertAssignable).toHaveBeenCalledWith('g-chess');
      expect(prisma.tournament.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ gameId: 'g-chess' }),
        }),
      );
    });

    it("prefers the organizer's choice over the format default", async () => {
      const { service, games } = buildService({ formatGameId: 'g-other' });
      await service.createTournament({ ...dto, gameId: 'g-chess' }, 'u1');
      expect(games.assertAssignable).toHaveBeenCalledWith('g-chess');
    });
  });

  describe('reassignGame', () => {
    it('validates the target through the same gate', async () => {
      const prisma = {
        tournament: {
          findUnique: jest.fn().mockResolvedValue({ id: 't1' }),
          update: jest.fn().mockResolvedValue({ id: 't1' }),
        },
      } as any;
      const games = {
        assertAssignable: jest
          .fn()
          .mockRejectedValue(
            new BadRequestException({ code: 'GAME_NOT_ASSIGNABLE' }),
          ),
      };
      const service = new TournamentService(
        prisma,
        {} as any,
        {} as any,
        {} as any,
        { notify: jest.fn(), notifyMany: jest.fn() } as any,
        games as any,
      );
      await expect(service.reassignGame('t1', 'g-general')).rejects.toMatchObject(
        { response: { code: 'GAME_NOT_ASSIGNABLE' } },
      );
      expect(prisma.tournament.update).not.toHaveBeenCalled();
    });
  });
});
