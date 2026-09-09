import { Injectable } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { TournamentStatus } from '@prisma/client';

/**
 * Unified "global omnibox" search across people and tournaments — the lively
 * counterpart to the browse-list filter. Case-insensitive substring match
 * (`ILIKE`), which needs no Postgres extension and works everywhere; it can be
 * upgraded to trigram similarity (`pg_trgm`) later for typo-tolerance without
 * changing this contract.
 *
 * Safety: guests are never returned (they have no lasting profile), and only
 * public (non-private) tournaments are searchable, so an unlisted event never
 * leaks through the unguarded endpoint.
 */
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(rawQuery: string | undefined) {
    const q = (rawQuery ?? '').trim();
    if (q.length < 1) return { users: [], tournaments: [] };

    const [users, tournaments] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          isGuest: false,
          username: { contains: q, mode: 'insensitive' },
        },
        select: {
          id: true,
          username: true,
          slug: true,
          avatarUrl: true,
          globalStats: {
            select: {
              tournamentsPlayed: true,
              tournamentsWon: true,
              globalPoints: true,
            },
          },
        },
        take: 20,
      }),
      this.prisma.tournament.findMany({
        where: {
          isPrivate: false,
          name: { contains: q, mode: 'insensitive' },
        },
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          date: true,
          game: { select: { name: true } },
          format: { select: { system: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
    ]);

    // Light relevance rank for people: a name that starts with the query beats a
    // mid-string match, then more-decorated players first. Keeps the best 8.
    const lc = q.toLowerCase();
    const rankedUsers = users
      .map((u) => ({
        id: u.id,
        username: u.username,
        slug: u.slug,
        avatarUrl: u.avatarUrl,
        tournamentsPlayed: u.globalStats?.tournamentsPlayed ?? 0,
        tournamentsWon: u.globalStats?.tournamentsWon ?? 0,
        globalPoints: u.globalStats?.globalPoints ?? 0,
        _starts: (u.username ?? '').toLowerCase().startsWith(lc) ? 0 : 1,
      }))
      .sort(
        (a, b) =>
          a._starts - b._starts ||
          b.tournamentsWon - a.tournamentsWon ||
          b.globalPoints - a.globalPoints,
      )
      .slice(0, 8)
      .map(({ _starts, ...rest }) => rest);

    return {
      users: rankedUsers,
      tournaments: tournaments.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        status: t.status as TournamentStatus,
        date: t.date ? t.date.toISOString() : null,
        game: t.game?.name ?? null,
        format: t.format?.system ?? null,
      })),
    };
  }

  /**
   * Discovery feed for the Community landing state (before any query): the most
   * recent champions, so a visitor immediately sees "who's winning" and has
   * players to look up. Public tournaments with a non-guest winner only. Top
   * players are not here — the frontend reuses the existing global leaderboard.
   */
  async spotlight() {
    const recent = await this.prisma.tournament.findMany({
      where: {
        isPrivate: false,
        status: TournamentStatus.COMPLETED,
        winnerId: { not: null },
        winner: { isGuest: false },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        date: true,
        createdAt: true,
        game: { select: { name: true } },
        winner: { select: { id: true, username: true, slug: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 6,
    });

    return {
      recentChampions: recent.map((t) => ({
        tournamentId: t.id,
        tournamentName: t.name,
        tournamentSlug: t.slug,
        date: (t.date ?? t.createdAt).toISOString(),
        game: t.game?.name ?? null,
        winner: t.winner
          ? {
              id: t.winner.id,
              username: t.winner.username,
              slug: t.winner.slug,
              avatarUrl: t.winner.avatarUrl,
            }
          : null,
      })),
    };
  }
}
