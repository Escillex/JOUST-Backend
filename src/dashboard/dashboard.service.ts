import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { roundText } from '../audit/audit.decorator';
import {
  MatchStatus,
  ParticipantStatus,
  TournamentStatus,
} from '@prisma/client';

/**
 * Everything the signed-in home page draws, in one response.
 *
 * The dashboard is the page most likely to be opened on venue Wi-Fi, and it
 * needs pieces of six different domains. Composing it client-side meant one
 * request per tournament you are entered in plus a handful more for the rest,
 * which is exactly the shape Core Rule 8 warns about. This is one round trip
 * carrying only the fields the two views actually render.
 *
 * Every section is resolved independently and failure-isolated: a section that
 * throws comes back empty rather than taking the whole dashboard down with it.
 * A home page that renders four of its six panels is worth far more than a 500.
 */

export interface DashboardOpponent {
  id: string;
  /** Nullable in the schema, so it is nullable here — render via a name helper. */
  username: string | null;
  displayName: string | null;
  slug: string | null;
  avatarUrl: string | null;
  isGuest: boolean;
}

export interface DashboardEntry {
  id: string;
  name: string;
  status: TournamentStatus;
  date: Date | null;
  game: { id: string; name: string; iconUrl: string | null } | null;
  seed: number | null;
  placement: number | null;
  fieldSize: number;
  maxPlayers: number;
  round: { number: number; label: string } | null;
  /** Your match in the tournament's current round, if you have one. */
  myMatch: {
    id: string;
    status: MatchStatus;
    isBye: boolean;
    opponent: DashboardOpponent | null;
    myScore: number;
    opponentScore: number;
  } | null;
  standing: {
    position: number | null;
    wins: number;
    losses: number;
    draws: number;
    points: number;
  } | null;
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private prisma: PrismaService,
    private leaderboard: LeaderboardService,
  ) {}

  /** Runs a section, and swallows its failure into a fallback. */
  private async safe<T>(
    label: string,
    run: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    try {
      return await run();
    } catch (err) {
      this.logger.warn(`dashboard section "${label}" failed: ${String(err)}`);
      return fallback;
    }
  }

  async getDashboard(userId: string) {
    const [entries, openToJoin, record, boards, collection, community, store] =
      await Promise.all([
        this.safe('entries', () => this.entries(userId), []),
        this.safe('openToJoin', () => this.openToJoin(userId), []),
        this.safe('record', () => this.leaderboard.getUserStats(userId), null),
        this.safe('boards', () => this.boards(userId), []),
        this.safe('collection', () => this.collection(userId), {
          medals: 0,
          plaques: 0,
          photos: 0,
          builds: 0,
        }),
        this.safe('community', () => this.community(), {
          champion: null,
          newMembers: 0,
        }),
        this.safe('store', () => this.store(), { items: 0, featured: null }),
      ]);

    return {
      entries,
      openToJoin,
      record,
      boards,
      collection,
      community,
      store,
    };
  }

  /**
   * The tournaments you are in and have not finished — the desktop lanes, and
   * the count behind the phone's Compete door.
   */
  private async entries(userId: string): Promise<DashboardEntry[]> {
    const participations = await this.prisma.tournamentParticipant.findMany({
      where: {
        userId,
        status: ParticipantStatus.ACTIVE,
        tournament: { status: { not: TournamentStatus.COMPLETED } },
      },
      include: {
        stats: true,
        tournament: {
          include: {
            game: { select: { id: true, name: true, iconUrl: true } },
            _count: { select: { participants: true } },
            rounds: {
              orderBy: { roundNumber: 'desc' },
              take: 1,
              include: {
                matches: {
                  where: { OR: [{ player1Id: userId }, { player2Id: userId }] },
                  include: {
                    player1: this.playerSelect(),
                    player2: this.playerSelect(),
                  },
                },
              },
            },
          },
        },
      },
    });

    // Standings are computed per tournament from the same per-participant stats
    // the standings table reads, so a lane can never disagree with the page it
    // links to. Dense ranking, matching the leaderboard's 2026-09-16 change.
    const positions = await this.positions(
      participations.map((p) => p.tournamentId),
    );

    return participations
      .map((p): DashboardEntry => {
        const t = p.tournament;
        const round = t.rounds[0] ?? null;
        const match = round?.matches[0] ?? null;
        const amPlayer1 = match?.player1Id === userId;
        const other = match
          ? amPlayer1
            ? match.player2
            : match.player1
          : null;

        return {
          id: t.id,
          name: t.name,
          status: t.status,
          date: t.date,
          game: t.game,
          seed: p.seed,
          placement: p.placement,
          fieldSize: t._count.participants,
          maxPlayers: t.maxPlayers,
          round: round
            ? { number: round.roundNumber, label: roundText(round.roundNumber) }
            : null,
          myMatch: match
            ? {
                id: match.id,
                status: match.status,
                isBye: match.isBye,
                opponent: other ?? null,
                myScore: amPlayer1 ? match.player1Score : match.player2Score,
                opponentScore: amPlayer1
                  ? match.player2Score
                  : match.player1Score,
              }
            : null,
          standing: p.stats
            ? {
                position: positions.get(p.id) ?? null,
                wins: p.stats.wins,
                losses: p.stats.losses,
                draws: p.stats.draws,
                points: p.stats.points,
              }
            : null,
        };
      })
      .sort((a, b) => {
        // A match you can act on outranks everything else on this page.
        const act = (e: DashboardEntry) =>
          e.myMatch && e.myMatch.status !== MatchStatus.COMPLETED ? 0 : 1;
        if (act(a) !== act(b)) return act(a) - act(b);
        const live = (e: DashboardEntry) =>
          e.status === TournamentStatus.ONGOING ? 0 : 1;
        if (live(a) !== live(b)) return live(a) - live(b);
        const when = (e: DashboardEntry) =>
          e.date ? new Date(e.date).getTime() : Infinity;
        return when(a) - when(b);
      });
  }

  private playerSelect() {
    return {
      select: {
        id: true,
        username: true,
        displayName: true,
        slug: true,
        avatarUrl: true,
        isGuest: true,
      },
    };
  }

  /** participantId -> dense rank by points within its tournament. */
  private async positions(
    tournamentIds: string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (tournamentIds.length === 0) return out;

    const rows = await this.prisma.tournamentParticipant.findMany({
      where: {
        tournamentId: { in: tournamentIds },
        status: ParticipantStatus.ACTIVE,
      },
      select: {
        id: true,
        tournamentId: true,
        stats: { select: { points: true } },
      },
    });

    const byTournament = new Map<string, { id: string; points: number }[]>();
    for (const r of rows) {
      const list = byTournament.get(r.tournamentId) ?? [];
      list.push({ id: r.id, points: r.stats?.points ?? 0 });
      byTournament.set(r.tournamentId, list);
    }

    for (const list of byTournament.values()) {
      list.sort((a, b) => b.points - a.points);
      let rank = 0;
      let lastPoints: number | null = null;
      list.forEach((row) => {
        if (lastPoints === null || row.points !== lastPoints) {
          rank += 1;
          lastPoints = row.points;
        }
        out.set(row.id, rank);
      });
    }
    return out;
  }

  /** A few tournaments you could enter, preferring the games you say you play. */
  private async openToJoin(userId: string) {
    const played = await this.prisma.userGame.findMany({
      where: { userId },
      select: { gameId: true },
    });
    const mine = new Set(played.map((g) => g.gameId));

    const rows = await this.prisma.tournament.findMany({
      where: {
        status: { in: [TournamentStatus.OPEN, TournamentStatus.UPCOMING] },
        isPrivate: false,
        participants: { none: { userId } },
      },
      orderBy: [{ date: 'asc' }, { createdAt: 'desc' }],
      take: 12,
      include: {
        game: { select: { id: true, name: true, iconUrl: true } },
        _count: { select: { participants: true } },
      },
    });

    return rows
      .map((t) => ({
        id: t.id,
        name: t.name,
        date: t.date,
        status: t.status,
        game: t.game,
        maxPlayers: t.maxPlayers,
        participantCount: t._count.participants,
        seatsLeft: Math.max(0, t.maxPlayers - t._count.participants),
      }))
      .sort((a, b) => {
        const g = (x: typeof a) => (x.game && mine.has(x.game.id) ? 0 : 1);
        if (g(a) !== g(b)) return g(a) - g(b);
        return 0;
      })
      .slice(0, 4);
  }

  /** Your standing on the boards for the games you play. */
  private async boards(userId: string) {
    const played = await this.prisma.userGame.findMany({
      where: { userId },
      include: { game: { select: { id: true, name: true, iconUrl: true } } },
      take: 3,
    });

    return Promise.all(
      played.map(async (p) => {
        const board = await this.leaderboard.getGlobalLeaderboard(p.game.name);
        const me = board.find((e) => e.userId === userId) ?? null;
        const leader = board[0] ?? null;
        return {
          game: p.game,
          myRank: me?.rank ?? null,
          myPoints: me?.points ?? null,
          leader: leader
            ? {
                name: leader.displayName || leader.username,
                points: leader.points,
              }
            : null,
        };
      }),
    );
  }

  /** Counts behind the Collection door. */
  private async collection(userId: string) {
    const [awards, photos, builds] = await Promise.all([
      this.prisma.userAward.findMany({
        where: { userId },
        select: { award: { select: { kind: true } } },
      }),
      this.prisma.galleryImage.count({ where: { userId, removedAt: null } }),
      this.prisma.tournamentBuild.count({ where: { userId } }),
    ]);

    return {
      medals: awards.filter((a) => a.award.kind === 'MEDAL').length,
      plaques: awards.filter((a) => a.award.kind === 'PLAQUE').length,
      photos,
      builds,
    };
  }

  /** The Community door: who last won something, and how many people are new. */
  private async community() {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [latest, newMembers] = await Promise.all([
      this.prisma.tournament.findFirst({
        where: { status: TournamentStatus.COMPLETED, winnerId: { not: null } },
        orderBy: { completedAt: 'desc' },
        select: {
          name: true,
          completedAt: true,
          winner: { select: { username: true, displayName: true, slug: true } },
        },
      }),
      this.prisma.user.count({
        where: { isGuest: false, createdAt: { gte: weekAgo } },
      }),
    ]);

    return {
      champion: latest?.winner
        ? {
            name: latest.winner.displayName || latest.winner.username,
            slug: latest.winner.slug,
            tournament: latest.name,
            at: latest.completedAt,
          }
        : null,
      newMembers,
    };
  }

  /** The Store door: how much is on sale and one thing to show for it. */
  private async store() {
    const [items, featured] = await Promise.all([
      this.prisma.storeProduct.count({ where: { isVisible: true } }),
      this.prisma.storeProduct.findFirst({
        where: { isVisible: true },
        orderBy: { createdAt: 'desc' },
        select: { name: true, price: true, imageUrl: true, link: true },
      }),
    ]);
    return { items, featured };
  }
}
