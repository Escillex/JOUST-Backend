import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AuthService } from '../src/auth/auth.service';
import { ImagesService } from '../src/images/images.service';
import { GAMES_PLAYED_MAX, UpdateMeDto } from '../src/auth/dto/auth.dto';
import { flattenGamesPlayed } from '../src/game/games-played.helper';

/**
 * "Games I play" — the self-declared list that orders the browse page and shows
 * on the public profile. It is written through `PATCH /auth/me`, so the DTO is
 * the only thing standing between a session and an unbounded number of join
 * rows.
 */
describe('games played', () => {
  const buildAuth = (
    games: { id: string }[] = [],
    user: any = { id: 'u1', username: 'mae' },
  ) => {
    const prisma: any = {
      user: {
        findUnique: jest.fn().mockResolvedValue(user),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(async ({ data }: any) => ({
          id: 'u1',
          ...data,
          games: [],
        })),
      },
      game: { findMany: jest.fn().mockResolvedValue(games) },
    };
    return { prisma, svc: new AuthService(prisma, {} as any, {} as any) };
  };

  it('refuses more games than the cap, and anything that is not a uuid', async () => {
    const tooMany = plainToInstance(UpdateMeDto, {
      gameIds: Array.from(
        { length: GAMES_PLAYED_MAX + 1 },
        () => '11111111-1111-4111-8111-111111111111',
      ),
    });
    const notIds = plainToInstance(UpdateMeDto, { gameIds: ['lorcana'] });
    const ok = plainToInstance(UpdateMeDto, {
      gameIds: ['11111111-1111-4111-8111-111111111111'],
    });

    expect((await validate(tooMany)).map((e) => e.property)).toContain(
      'gameIds',
    );
    expect((await validate(notIds)).map((e) => e.property)).toContain(
      'gameIds',
    );
    expect(await validate(ok)).toHaveLength(0);
  });

  it('accepts an empty list — that is how you clear it', async () => {
    const { prisma, svc } = buildAuth([]);
    await svc.updateMe('u1', { gameIds: [] } as UpdateMeDto);
    expect(prisma.user.update.mock.calls[0][0].data.games).toEqual({
      deleteMany: {},
      create: [],
    });
  });

  it('writes the whole set, and silently drops ids the catalog does not have', async () => {
    // The page listed three; by the time it saved, only two still exist.
    const { prisma, svc } = buildAuth([{ id: 'g1' }, { id: 'g2' }]);
    await svc.updateMe('u1', { gameIds: ['g1', 'g2', 'gone'] } as UpdateMeDto);

    expect(prisma.game.findMany.mock.calls[0][0].where).toEqual({
      id: { in: ['g1', 'g2', 'gone'] },
      isBuiltin: false,
    });
    expect(prisma.user.update.mock.calls[0][0].data.games).toEqual({
      deleteMany: {},
      create: [{ gameId: 'g1' }, { gameId: 'g2' }],
    });
  });

  it('never lists the retired system placeholder', async () => {
    // `isBuiltin: false` is part of the lookup, so a builtin id resolves to
    // nothing and is dropped like any unknown id.
    const { prisma, svc } = buildAuth([]);
    await svc.updateMe('u1', { gameIds: ['general'] } as UpdateMeDto);
    expect(prisma.game.findMany.mock.calls[0][0].where.isBuiltin).toBe(false);
    expect(prisma.user.update.mock.calls[0][0].data.games.create).toEqual([]);
  });

  it('refuses a guest — there is no profile to show it on', async () => {
    const { svc } = buildAuth([{ id: 'g1' }], {
      id: 'guest',
      username: 'Bea',
      isGuest: true,
    });
    await expect(
      svc.updateMe('guest', { gameIds: ['g1'] } as UpdateMeDto),
    ).rejects.toThrow(/Guest accounts cannot list games/);
  });

  it('leaves the list alone when the field is absent', async () => {
    // Editing a bio must not wipe the games.
    const { prisma, svc } = buildAuth([]);
    await svc.updateMe('u1', { bio: 'Plays Swiss.' } as UpdateMeDto);
    expect(prisma.user.update.mock.calls[0][0].data.games).toBeUndefined();
    expect(prisma.game.findMany).not.toHaveBeenCalled();
  });

  it('serves the join rows unwrapped, so both sides speak one shape', () => {
    expect(
      flattenGamesPlayed([
        {
          game: { id: 'g1', name: 'Lorcana', iconUrl: '/uploads/games/a.webp' },
        },
        { game: { id: 'g2', name: 'Chess', iconUrl: null } },
      ]),
    ).toEqual([
      { id: 'g1', name: 'Lorcana', iconUrl: '/uploads/games/a.webp' },
      { id: 'g2', name: 'Chess', iconUrl: null },
    ]);
    expect(flattenGamesPlayed(undefined)).toEqual([]);
  });
});

/** The catalog's 1:1 icon — `Game.iconUrl` existed from the start but nothing
 *  ever wrote it, so every game rendered as bare text. */
describe('game icon', () => {
  const buildImages = (game: any) => {
    const prisma: any = {
      game: {
        findUnique: jest.fn().mockResolvedValue(game),
        update: jest.fn(async ({ data }: any) => ({ id: game?.id, ...data })),
      },
    };
    const svc = new ImagesService(prisma);
    jest
      .spyOn(svc, 'processAndSave')
      .mockResolvedValue('/uploads/games/new.webp');
    jest.spyOn(svc, 'deleteFile').mockResolvedValue(undefined);
    return { prisma, svc };
  };

  it('saves the new icon before removing the old one', async () => {
    const { prisma, svc } = buildImages({
      id: 'g1',
      iconUrl: '/uploads/games/old.webp',
    });
    const out = await svc.updateGameIcon('g1', {} as Express.Multer.File);

    expect(svc.processAndSave).toHaveBeenCalledWith({}, 'games');
    expect(out).toEqual({ id: 'g1', iconUrl: '/uploads/games/new.webp' });
    // Commit first, delete second: a failed upload must not destroy the icon
    // that is already there.
    expect(prisma.game.update).toHaveBeenCalled();
    expect(svc.deleteFile).toHaveBeenCalledWith('/uploads/games/old.webp');
  });

  it('removes the icon and the file it pointed at', async () => {
    const { svc } = buildImages({
      id: 'g1',
      iconUrl: '/uploads/games/old.webp',
    });
    const out = await svc.deleteGameIcon('g1');
    expect(svc.deleteFile).toHaveBeenCalledWith('/uploads/games/old.webp');
    expect(out).toEqual({ id: 'g1', iconUrl: null });
  });

  it('refuses the retired system game, as every other edit path does', async () => {
    const { svc } = buildImages({
      id: 'general',
      isBuiltin: true,
      iconUrl: null,
    });
    await expect(
      svc.updateGameIcon('general', {} as Express.Multer.File),
    ).rejects.toThrow(/retired system game/);
    await expect(svc.deleteGameIcon('general')).rejects.toThrow(
      /retired system game/,
    );
  });

  it('404s on a game that does not exist', async () => {
    const { svc } = buildImages(null);
    await expect(
      svc.updateGameIcon('nope', {} as Express.Multer.File),
    ).rejects.toThrow(/Game not found/);
  });
});
