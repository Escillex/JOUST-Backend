import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { MatchStatus, TournamentStatus } from '@prisma/client';
import { PUBLIC_AWARD_SELECT, toPublicAward } from '../award/award.service';
import { roundText } from '../audit/audit.decorator';
import { systemOf } from '../Formats/format-config.helper';
import {
  GAMES_PLAYED_SELECT,
  flattenGamesPlayed,
} from '../game/games-played.helper';

/** Tournaments per page of match history. A page is a handful of cards on a
 *  phone; a whole career in one response is what venue Wi-Fi chokes on. */
const HISTORY_PAGE = 8;
const HISTORY_PAGE_MAX = 20;

export interface UserStats {
  userId: string;
  wins: number;
  losses: number;
  winRate: number;
  tournamentsPlayed: number;
  rank: number | null;
}

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  /** Resolve a profile reference that may be a slug OR a legacy UUID, so old
   *  UUID links keep working after the switch to username handles. */
  private async resolveUser(handle: string) {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ slug: handle }, { id: handle }] },
      select: {
        id: true,
        username: true,
        displayName: true,
        bio: true,
        slug: true,
        avatarUrl: true,
        isGuest: true,
        roles: true,
        createdAt: true,
        games: GAMES_PLAYED_SELECT,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /** Public profile bundle for the profile page: basic identity, lifetime stats,
   *  and recent COMPLETED tournaments with the user's placement (drives the
   *  top-3 showcase). Resolves by slug or UUID. */
  async getPublicProfile(handle: string) {
    const user = await this.resolveUser(handle);

    const globalStats = await this.prisma.userGlobalStats.findUnique({
      where: { userId: user.id },
    });

    const participations = await this.prisma.tournamentParticipant.findMany({
      where: {
        userId: user.id,
        tournament: { status: TournamentStatus.COMPLETED },
      },
      select: {
        placement: true,
        tournament: {
          select: {
            id: true,
            name: true,
            slug: true,
            date: true,
            createdAt: true,
            system: true,
            format: { select: { system: true, name: true } },
            game: { select: { name: true } },
          },
        },
      },
      take: 50,
    });

    // Every award, newest first. The profile derives the showcase (pinned
    // medals, displayed plaque) from pinSlot/displayed, and groups repeats.
    const awards = (
      await this.prisma.userAward.findMany({
        where: { userId: user.id },
        orderBy: { awardedAt: 'desc' },
        select: PUBLIC_AWARD_SELECT,
      })
    ).map(toPublicAward);

    // The profile gallery (obj. 4.3): one live image per game.
    const gallery = (
      await this.prisma.galleryImage.findMany({
        where: { userId: user.id, removedAt: null },
        orderBy: { updatedAt: 'desc' },
        include: { game: { select: { name: true } } },
      })
    ).map((g) => ({
      id: g.id,
      gameId: g.gameId,
      gameName: g.game.name,
      imageUrl: g.imageUrl,
      caption: g.caption,
      updatedAt: g.updatedAt.toISOString(),
    }));

    const recentTournaments = participations
      .map((p) => ({
        id: p.tournament.id,
        name: p.tournament.name,
        slug: p.tournament.slug,
        date: (p.tournament.date ?? p.tournament.createdAt).toISOString(),
        placement: p.placement,
        format: systemOf(p.tournament) ?? null,
        game: p.tournament.game?.name ?? null,
      }))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 12);

    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      bio: user.bio,
      slug: user.slug,
      avatarUrl: user.avatarUrl,
      isGuest: user.isGuest,
      roles: user.roles,
      memberSince: user.createdAt,
      // Self-declared, unlike `stats`, which is earned. Shown as a row of icons
      // under the handle.
      games: flattenGamesPlayed(user.games),
      stats: globalStats
        ? {
            tournamentsPlayed: globalStats.tournamentsPlayed,
            tournamentsWon: globalStats.tournamentsWon,
            wins: globalStats.wins,
            losses: globalStats.losses,
            draws: globalStats.draws,
            winRate: globalStats.winRate,
            globalPoints: globalStats.globalPoints,
          }
        : null,
      recentTournaments,
      awards,
      gallery,
    };
  }

  async getUserStats(userId: string): Promise<UserStats> {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(userId)) {
      throw new BadRequestException('Invalid user ID format');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Wins and losses. Byes are excluded (F14): a bye sets winnerId but is not a
    // played game, and counting it as a win inflates the record — the losses query
    // below already excludes byes, so wins must too.
    const wins = await this.prisma.match.count({
      where: {
        winnerId: userId,
        status: MatchStatus.COMPLETED,
        NOT: { isBye: true },
      },
    });

    const losses = await this.prisma.match.count({
      where: {
        status: MatchStatus.COMPLETED,
        OR: [
          { player1Id: userId, NOT: { winnerId: userId } },
          { player2Id: userId, NOT: { winnerId: userId } },
        ],
        NOT: { isBye: true },
      },
    });

    const winRate = wins + losses === 0 ? 0 : wins / (wins + losses);

    // Tournaments played
    const tournamentsPlayed = await this.prisma.tournamentParticipant.count({
      where: { userId },
    });

    // Rank computation
    // "order users by wins DESC, assign rank 1 to highest. Return null if user has 0 matches."
    let rank: number | null = null;

    if (wins + losses > 0) {
      // Optimization: Count how many unique users have more wins than this user
      // This is a simplified ranking as per requirements (by wins DESC)

      // Since Prisma doesn't have a direct "rank" window function in a simple way without raw SQL,
      // we can use a group by or count unique users with more wins.

      const usersWithMoreWins = await this.prisma.match.groupBy({
        by: ['winnerId'],
        where: {
          winnerId: { not: null },
          status: MatchStatus.COMPLETED,
          // Same as the win count above (F14): byes are not real wins, so they
          // must not inflate anyone's total in the ranking comparison either.
          NOT: { isBye: true },
        },
        _count: {
          winnerId: true,
        },
        having: {
          winnerId: {
            _count: {
              gt: wins,
            },
          },
        },
      });

      rank = usersWithMoreWins.length + 1;
    }

    return {
      userId,
      wins,
      losses,
      winRate,
      tournamentsPlayed,
      rank,
    };
  }

  /**
   * A player's whole match history, grouped by tournament — newest tournament
   * first, matches in round order inside each — and paged by tournament. Each
   * match is told from this player's side (result, their score first, the
   * opponent). Resolves by slug or UUID, like the profile.
   *
   * The profile's "recent matches" (getUserMatches) stays as it is: the last
   * 15, flat. This is the page behind its "View all matches".
   */
  async getMatchHistory(handle: string, offset = 0, limit = HISTORY_PAGE) {
    const user = await this.resolveUser(handle);
    const take = Math.min(
      Math.max(1, Math.floor(limit) || HISTORY_PAGE),
      HISTORY_PAGE_MAX,
    );
    const skip = Math.max(0, Math.floor(offset) || 0);

    const played = {
      status: MatchStatus.COMPLETED,
      isBye: false,
      OR: [{ player1Id: user.id }, { player2Id: user.id }],
    };

    // Every tournament they played a real match in. Ordered here rather than in
    // SQL because "when" is date ?? createdAt — the same rule the profile uses —
    // and one person's tournaments are few enough to sort in memory.
    const all = await this.prisma.tournament.findMany({
      where: { rounds: { some: { matches: { some: played } } } },
      select: { id: true, date: true, createdAt: true },
    });
    const when = (t: { date: Date | null; createdAt: Date }) =>
      (t.date ?? t.createdAt).getTime();
    const pageIds = all
      .sort((a, b) => when(b) - when(a))
      .slice(skip, skip + take)
      .map((t) => t.id);

    const [tournaments, matches, entries] = await Promise.all([
      this.prisma.tournament.findMany({
        where: { id: { in: pageIds } },
        select: {
          id: true,
          name: true,
          date: true,
          createdAt: true,
          status: true,
          system: true,
          format: { select: { system: true } },
          game: { select: { name: true } },
        },
      }),
      this.prisma.match.findMany({
        where: { ...played, round: { tournamentId: { in: pageIds } } },
        orderBy: [{ round: { roundNumber: 'asc' } }, { matchIndex: 'asc' }],
        select: {
          id: true,
          player1Id: true,
          player2Id: true,
          player1Score: true,
          player2Score: true,
          winnerId: true,
          p1Name: true,
          p2Name: true,
          completedAt: true,
          createdAt: true,
          round: { select: { roundNumber: true, tournamentId: true } },
          player1: {
            select: {
              id: true,
              username: true,
              displayName: true,
              slug: true,
              avatarUrl: true,
            },
          },
          player2: {
            select: {
              id: true,
              username: true,
              displayName: true,
              slug: true,
              avatarUrl: true,
            },
          },
        },
      }),
      this.prisma.tournamentParticipant.findMany({
        where: { userId: user.id, tournamentId: { in: pageIds } },
        select: { tournamentId: true, placement: true },
      }),
    ]);

    const byId = new Map(tournaments.map((t) => [t.id, t]));
    const placement = new Map(
      entries.map((e) => [e.tournamentId, e.placement]),
    );

    const groups = pageIds.map((id) => {
      const t = byId.get(id)!;
      return {
        tournament: {
          id: t.id,
          name: t.name,
          date: (t.date ?? t.createdAt).toISOString(),
          status: t.status,
          format: systemOf(t) ?? null,
          game: t.game?.name ?? null,
          placement: placement.get(id) ?? null,
        },
        matches: matches
          .filter((m) => m.round.tournamentId === id)
          .map((m) => {
            const mine = m.player1Id === user.id;
            const opp = mine ? m.player2 : m.player1;
            // A deleted opponent has no account left, only the name burned into
            // the match (deleteUser); a guest or TBD has neither.
            const oppName =
              opp?.displayName ||
              opp?.username ||
              (mine ? m.p2Name : m.p1Name) ||
              'TBD';
            return {
              id: m.id,
              round: m.round.roundNumber,
              roundLabel: roundText(m.round.roundNumber),
              result:
                m.winnerId === user.id
                  ? 'win'
                  : m.winnerId === null
                    ? 'draw'
                    : 'loss',
              myScore: mine ? m.player1Score : m.player2Score,
              oppScore: mine ? m.player2Score : m.player1Score,
              opponent: opp
                ? {
                    id: opp.id,
                    slug: opp.slug,
                    name: oppName,
                    avatarUrl: opp.avatarUrl,
                  }
                : { id: null, slug: null, name: oppName, avatarUrl: null },
              completedAt: (m.completedAt ?? m.createdAt).toISOString(),
            };
          }),
      };
    });

    const next = skip + pageIds.length;
    return {
      totalTournaments: all.length,
      offset: skip,
      nextOffset: next < all.length ? next : null,
      groups,
    };
  }

  async getUserMatches(userId: string) {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(userId)) {
      throw new BadRequestException('Invalid user ID format');
    }

    const matches = await this.prisma.match.findMany({
      where: {
        status: MatchStatus.COMPLETED,
        OR: [{ player1Id: userId }, { player2Id: userId }],
        NOT: { isBye: true },
      },
      include: {
        round: { include: { tournament: true } },
        player1: {
          select: {
            id: true,
            username: true,
            displayName: true,
            slug: true,
            avatarUrl: true,
          },
        },
        player2: {
          select: {
            id: true,
            username: true,
            displayName: true,
            slug: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 15,
    });

    return matches.map((match) => {
      let type = 'entry';
      if (match.winnerId === userId) {
        type = 'win';
      } else if (match.winnerId === null) {
        type = 'draw';
      } else {
        type = 'loss';
      }

      const isPlayer1 = match.player1Id === userId;
      const opponent = isPlayer1
        ? match.player2?.displayName ||
          match.player2?.username ||
          match.p2Name ||
          'TBD'
        : match.player1?.displayName ||
          match.player1?.username ||
          match.p1Name ||
          'TBD';

      const myScore = isPlayer1 ? match.player1Score : match.player2Score;
      const oppScore = isPlayer1 ? match.player2Score : match.player1Score;

      return {
        id: match.id,
        type,
        title: `${type.toUpperCase()} VS ${opponent}`,
        subtitle: match.round?.tournament?.name || 'Unknown Tournament',
        time: match.createdAt.toISOString().split('T')[0],
        value: `${myScore} - ${oppScore}`,
        player1: {
          id: match.player1Id,
          slug: match.player1?.slug || null,
          name:
            match.player1?.displayName ||
            match.player1?.username ||
            match.p1Name ||
            'TBD',
          avatarUrl: match.player1?.avatarUrl || null,
          score: match.player1Score,
        },
        player2: {
          id: match.player2Id,
          slug: match.player2?.slug || null,
          name:
            match.player2?.displayName ||
            match.player2?.username ||
            match.p2Name ||
            'TBD',
          avatarUrl: match.player2?.avatarUrl || null,
          score: match.player2Score,
        },
        isPlayer1,
      };
    });
  }
}
