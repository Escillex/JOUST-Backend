import { NotFoundException } from '@nestjs/common';
import { RoundService } from '../src/tournament/round/round.service';
import type { PrismaService } from 'prisma/prisma.service';

/**
 * `GET /tournaments/:id/rounds` is the live view's data source — the screen
 * left running on a projector all day — and it is the only route that serves
 * matches *without* going through `TournamentService`.
 *
 * That made it the one place a player could arrive missing fields the frontend
 * declares. It did: the route selected `{ id, username }` while the frontend's
 * `Match` type declares `{ id, username, displayName?, isGuest? }` and renders
 * every person through `displayNameOf()`, which reads `displayName` first. So
 * the live tiles showed "mira-calder" where the bracket beside them showed
 * "Mira Calder" — the exact mismatch `completeTournament` burns display names
 * into its match snapshots to prevent.
 *
 * These tests pin the shape against the tournament route's, which is the
 * standard. Core Rule 9: a contract one side declares, the other must honour.
 */

const TOURNAMENT = 't1';

/** Exactly what `GET /tournaments/:id` selects for a match player. */
const TOURNAMENT_ROUTE_PLAYER_FIELDS = [
  'id',
  'username',
  'displayName',
  'isGuest',
];

function harness(rounds: any[] = [], round: any = null) {
  const prisma = {
    round: {
      findMany: jest.fn().mockResolvedValue(rounds),
      findUnique: jest.fn().mockResolvedValue(round),
    },
  };
  return { svc: new RoundService(prisma as unknown as PrismaService), prisma };
}

/** The `select` object the service asked Prisma for, per relation. */
function selectedFields(include: any, relation: string): string[] {
  return Object.keys(include.matches.include[relation].select).sort();
}

describe('round payload — the player shape matches the tournament route', () => {
  it('asks for displayName and isGuest on both players and the winner (getRounds)', async () => {
    const h = harness();
    await h.svc.getRounds(TOURNAMENT);
    const { include } = h.prisma.round.findMany.mock.calls[0][0];
    for (const relation of ['player1', 'player2', 'winner']) {
      expect(selectedFields(include, relation)).toEqual(
        [...TOURNAMENT_ROUTE_PLAYER_FIELDS].sort(),
      );
    }
  });

  it('asks for the same fields on the single-round read (getRound)', async () => {
    const h = harness([], { id: 'r1', roundNumber: 1, matches: [] });
    await h.svc.getRound(TOURNAMENT, 1);
    const { include } = h.prisma.round.findUnique.mock.calls[0][0];
    for (const relation of ['player1', 'player2', 'winner']) {
      expect(selectedFields(include, relation)).toEqual(
        [...TOURNAMENT_ROUTE_PLAYER_FIELDS].sort(),
      );
    }
  });

  it('uses one shared shape, so the two reads cannot drift apart', async () => {
    const h = harness([], { id: 'r1', roundNumber: 1, matches: [] });
    await h.svc.getRounds(TOURNAMENT);
    await h.svc.getRound(TOURNAMENT, 1);
    expect(h.prisma.round.findMany.mock.calls[0][0].include).toEqual(
      h.prisma.round.findUnique.mock.calls[0][0].include,
    );
  });

  it('never selects the email — this route is reachable unauthenticated', async () => {
    const h = harness();
    await h.svc.getRounds(TOURNAMENT);
    const json = JSON.stringify(h.prisma.round.findMany.mock.calls[0][0]);
    expect(json).not.toContain('email');
    expect(json).not.toContain('hashedPassword');
  });

  it('carries a display name through to the caller', async () => {
    // The regression in plain terms: what the live tile renders.
    const h = harness([
      {
        id: 'r1',
        roundNumber: 1,
        matches: [
          {
            id: 'm1',
            status: 'ONGOING',
            player1: {
              id: 'u1',
              username: 'mira-calder',
              displayName: 'Mira Calder',
              isGuest: false,
            },
            player2: {
              id: 'u2',
              username: 'quiet-heron',
              displayName: 'Quiet Heron',
              isGuest: true,
            },
            winner: null,
          },
        ],
      },
    ]);
    const [round] = await h.svc.getRounds(TOURNAMENT);
    expect(round.matches[0].player1.displayName).toBe('Mira Calder');
    expect(round.matches[0].player2.isGuest).toBe(true);
  });
});

describe('round payload — reads', () => {
  it('orders rounds so the bracket renders left to right', async () => {
    const h = harness();
    await h.svc.getRounds(TOURNAMENT);
    expect(h.prisma.round.findMany.mock.calls[0][0].orderBy).toEqual({
      roundNumber: 'asc',
    });
  });

  it('scopes the read to the requested tournament', async () => {
    const h = harness();
    await h.svc.getRounds(TOURNAMENT);
    expect(h.prisma.round.findMany.mock.calls[0][0].where).toEqual({
      tournamentId: TOURNAMENT,
    });
  });

  it('returns an empty list for a tournament that has not started', async () => {
    // No rounds yet is normal, not an error — the lobby polls this route.
    await expect(harness([]).svc.getRounds(TOURNAMENT)).resolves.toEqual([]);
  });

  it('addresses a single round by the composite key, not by scanning', async () => {
    const h = harness([], { id: 'r2', roundNumber: 2, matches: [] });
    await h.svc.getRound(TOURNAMENT, 2);
    expect(h.prisma.round.findUnique.mock.calls[0][0].where).toEqual({
      tournamentId_roundNumber: { tournamentId: TOURNAMENT, roundNumber: 2 },
    });
  });

  it('404s for a round that does not exist, naming it', async () => {
    const h = harness([], null);
    await expect(h.svc.getRound(TOURNAMENT, 9)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(h.svc.getRound(TOURNAMENT, 9)).rejects.toThrow(
      'Round 9 not found',
    );
  });
});
