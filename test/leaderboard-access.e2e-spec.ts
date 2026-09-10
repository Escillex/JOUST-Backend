import { ForbiddenException } from '@nestjs/common';
import { LeaderboardController } from '../src/leaderboard/leaderboard.controller';

// The cross-game board is an operator's view: it ranks players who may never
// have played the same game. Hiding the tab in the UI is not a restriction, so
// the refusal lives here and these cases pin it.
describe('cross-game leaderboard access', () => {
  const service = { getGlobalLeaderboard: jest.fn().mockResolvedValue([]) };
  const controller = new LeaderboardController(service as any);
  const req = (roles?: string[]) =>
    (roles ? { user: { roles } } : {}) as any;

  beforeEach(() => service.getGlobalLeaderboard.mockClear());

  // The handler refuses before it ever reaches the service, so the throw is
  // synchronous — asserting on a rejected promise would pass vacuously.
  it('refuses the combined board to an anonymous caller', () => {
    expect(() => controller.getGlobalLeaderboard(req())).toThrow(
      ForbiddenException,
    );
    expect(service.getGlobalLeaderboard).not.toHaveBeenCalled();
  });

  it('refuses the combined board to a signed-in non-admin', () => {
    expect(() =>
      controller.getGlobalLeaderboard(req(['PLAYER', 'ORGANIZER'])),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          code: 'CROSS_GAME_BOARD_ADMIN_ONLY',
        }),
      }) as unknown as Error,
    );
    expect(service.getGlobalLeaderboard).not.toHaveBeenCalled();
  });

  it('serves the combined board to an admin', async () => {
    await controller.getGlobalLeaderboard(req(['ADMIN', 'PLAYER']));
    expect(service.getGlobalLeaderboard).toHaveBeenCalledWith(undefined);
  });

  it('serves a per-game board to anyone, including anonymous', async () => {
    await controller.getGlobalLeaderboard(req(), 'Chess');
    await controller.getGlobalLeaderboard(req(['PLAYER']), 'Chess');
    expect(service.getGlobalLeaderboard).toHaveBeenNthCalledWith(1, 'Chess');
    expect(service.getGlobalLeaderboard).toHaveBeenNthCalledWith(2, 'Chess');
  });

  it('treats an empty game parameter as the combined board, not as a game', () => {
    // ?game= with nothing after it must not slip past the check as "a game".
    expect(() => controller.getGlobalLeaderboard(req(['PLAYER']), '')).toThrow(
      ForbiddenException,
    );
  });
});
