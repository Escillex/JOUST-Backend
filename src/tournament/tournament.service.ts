import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { FormatsService } from 'src/Formats/formats.service';
import {
  effectiveRawConfig,
  resolveConfig,
} from 'src/Formats/format-config.helper';
import { seedBracketSlots, shuffled } from 'src/Formats/bracket-seeding.helper';
import { LeaderboardService } from 'src/leaderboard/leaderboard.service';
import {
  CreateTournamentDto,
  UpdateTournamentDto,
  TournamentStatusDto,
} from './dto/tournament.dto';
import {
  Tournament,
  TournamentStatus,
  MatchStatus,
  Role,
  Prisma,
  NotificationType,
  OrganizerInviteStatus,
} from '@prisma/client';
import { JwtPayload } from 'src/guards/jwt-auth.guard';
import { checkTournamentAccess } from 'src/guards/tournament-access.util';
import { RealtimeGateway } from 'src/realtime/realtime.gateway';
import {
  NotificationService,
  NotifyInput,
} from 'src/notification/notification.service';

@Injectable()
export class TournamentService {
  public static GUEST_EXPIRY_DAYS = 30;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => FormatsService))
    private readonly formatsService: FormatsService,
    private readonly leaderboardService: LeaderboardService,
    private readonly realtime: RealtimeGateway,
    private readonly notifications: NotificationService,
  ) {}

  private readonly ALLOWED_TRANSITIONS: Record<
    TournamentStatus,
    TournamentStatus[]
  > = {
    [TournamentStatus.UPCOMING]: [TournamentStatus.OPEN],
    [TournamentStatus.PENDING]: [TournamentStatus.OPEN],
    [TournamentStatus.OPEN]: [TournamentStatus.ONGOING],
    [TournamentStatus.ONGOING]: [TournamentStatus.COMPLETED],
    [TournamentStatus.COMPLETED]: [],
  };

  // ─── STATUS ──────────────────────────────────────────────────

  async updateStatus(
    tournamentId: string,
    dto: TournamentStatusDto,
    user: JwtPayload,
  ) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');

    if (
      tournament.createdById !== user.id &&
      !user.roles.includes(Role.ADMIN)
    ) {
      throw new ForbiddenException(
        'Only the tournament organizer can update the status',
      );
    }

    const currentStatus = tournament.status;
    const targetStatus = dto.status;

    if (!this.ALLOWED_TRANSITIONS[currentStatus].includes(targetStatus)) {
      throw new BadRequestException(
        `Invalid status transition from ${currentStatus} to ${targetStatus}`,
      );
    }

    const updated = await this.prisma.tournament.update({
      where: { id: tournamentId },
      data: { status: targetStatus },
    });
    // Tell every open viewer of this tournament to refresh after a manual
    // status change (for example an organizer opening or completing it).
    this.realtime.emitTournamentUpdated(tournamentId);
    return updated;
  }

  async updateStatusInternal(
    tournamentId: string,
    targetStatus: TournamentStatus,
  ) {
    const updated = await this.prisma.tournament.update({
      where: { id: tournamentId },
      data: { status: targetStatus },
    });
    // Same refresh signal for automatic transitions (start / auto-complete).
    this.realtime.emitTournamentUpdated(tournamentId);

    // Completion deliberately does not notify here: completeTournament sends a
    // placement notification instead, which says more and avoids two messages
    // arriving for one event.
    if (
      targetStatus === TournamentStatus.OPEN ||
      targetStatus === TournamentStatus.ONGOING
    ) {
      const participants = await this.prisma.tournamentParticipant.findMany({
        where: { tournamentId },
        select: { userId: true },
      });
      await this.notifications.notifyMany(
        participants.map((p) => p.userId),
        {
          type:
            targetStatus === TournamentStatus.OPEN
              ? NotificationType.TOURNAMENT_OPENED
              : NotificationType.TOURNAMENT_STARTED,
          title:
            targetStatus === TournamentStatus.OPEN
              ? `Registration is open for ${updated.name}`
              : `${updated.name} has started`,
          link: `/tournaments/${tournamentId}/lobby`,
          tournamentId,
        },
      );
    }

    return updated;
  }

  // ─── CREATE ──────────────────────────────────────────────────

  /** Turns a tournament name into a short URL-safe invite name,
   *  e.g. "Summer Cup 2026!" becomes "summer-cup-2026". If that name is
   *  already used by another tournament, a number is appended
   *  ("summer-cup-2026-2") so the unique constraint on slug always holds. */
  private async generateUniqueSlug(name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'tournament';
    let candidate = base;
    for (let n = 2; ; n++) {
      const taken = await this.prisma.tournament.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!taken) return candidate;
      // Keep the total length within the 40-character column limit even
      // after the "-2", "-3", ... suffix is added.
      const suffix = `-${n}`;
      candidate = base.slice(0, 40 - suffix.length) + suffix;
    }
  }

  /** Rethrows a Prisma "unique constraint violated" error on the slug
   *  column as a clear message the frontend can show directly.
   *  The violated column is reported in two different places depending on
   *  the Prisma setup: classic engines use meta.target, while driver
   *  adapters (used here, Prisma 7 + adapter-pg) nest it under
   *  meta.driverAdapterError.constraint.fields — so both are checked. */
  private static rethrowSlugConflict(e: unknown): never {
    const err = e as {
      code?: string;
      meta?: {
        target?: string[];
        driverAdapterError?: {
          cause?: { constraint?: { fields?: string[] } };
        };
      };
    };
    const columns =
      err?.meta?.target ??
      err?.meta?.driverAdapterError?.cause?.constraint?.fields ??
      [];
    if (err?.code === 'P2002' && columns.includes('slug')) {
      throw new BadRequestException(
        'This invite link name is already taken by another tournament',
      );
    }
    throw e;
  }

  async createTournament(dto: CreateTournamentDto, createdById: string) {
    const existing = await this.prisma.tournament.findFirst({
      where: { name: dto.name, createdById },
    });
    if (existing) throw new BadRequestException('Tournament name exists');

    // Validate the format exists
    const fmt = await this.prisma.tournamentFormat.findUnique({
      where: { id: dto.formatId },
    });
    if (!fmt)
      throw new BadRequestException('Invalid formatId — format not found');

    // Resolve the game. Every tournament has exactly one (todo.md §5): the
    // organizer's explicit choice wins, else the format's default game, else the
    // built-in "General". An explicit choice is validated; General is the floor.
    let gameId: string | null = dto.gameId ?? fmt.gameId ?? null;
    if (dto.gameId) {
      const g = await this.prisma.game.findUnique({ where: { id: dto.gameId } });
      if (!g) throw new BadRequestException('Invalid gameId — game not found');
    }
    if (!gameId) {
      const general = await this.prisma.game.findUnique({
        where: { name: 'General' },
      });
      gameId = general?.id ?? null;
    }

    const status = dto.startNow
      ? TournamentStatus.OPEN
      : TournamentStatus.UPCOMING;

    // Every tournament gets a short invite name so share links are easy
    // to read. Organizers may send their own; otherwise one is generated
    // from the tournament name.
    const slug = dto.slug || (await this.generateUniqueSlug(dto.name));

    try {
      return await this.prisma.tournament.create({
        data: {
          name: dto.name,
          description: dto.description,
          maxPlayers: dto.maxPlayers,
          prizePool: dto.prizePool,
          entranceFee: dto.entranceFee,
          venue: dto.venue,
          date: dto.date ? new Date(dto.date) : undefined,
          isPrivate: dto.isPrivate,
          status,
          createdById,
          formatId: dto.formatId,
          gameId,
          slug,
          // A null config on create simply means "no override", so store
          // nothing. Prisma's create input does not accept a plain null
          // for JSON columns, which is why null is mapped to undefined.
          config: dto.config ?? undefined,
        },
        include: {
          createdBy: {
            select: { id: true, username: true, roles: true, email: true },
          },
          format: true,
          game: true,
        },
      });
    } catch (e) {
      // Happens only when the organizer sent a custom slug that another
      // tournament already uses; generated slugs are checked beforehand.
      TournamentService.rethrowSlugConflict(e);
    }
  }

  // ─── UPDATE ──────────────────────────────────────────────────

  async updateTournament(id: string, dto: UpdateTournamentDto) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');
    if (tournament.status !== TournamentStatus.OPEN)
      throw new BadRequestException('Cannot edit started tournament');

    if (dto.formatId) {
      const fmt = await this.prisma.tournamentFormat.findUnique({
        where: { id: dto.formatId },
      });
      if (!fmt)
        throw new BadRequestException('Invalid formatId — format not found');
    }

    if (dto.gameId) {
      const g = await this.prisma.game.findUnique({ where: { id: dto.gameId } });
      if (!g) throw new BadRequestException('Invalid gameId — game not found');
    }

    // createdById is no longer a DTO field (F3); ownership is never changed on update.
    const { date, startNow, config, slug, ...rest } = dto;

    try {
      return await this.prisma.tournament.update({
        where: { id },
        data: {
          ...rest,
          // config: null clears the per-tournament override (falls back to the preset)
          ...(config !== undefined && { config: config ?? Prisma.DbNull }),
          ...(date !== undefined && { date: date ? new Date(date) : null }),
          // An empty string means "remove the custom invite name"; the long
          // inviteToken UUID then becomes the only working invite link.
          ...(slug !== undefined && { slug: slug === '' ? null : slug }),
        },
        include: {
          format: true,
          game: true,
        },
      });
    } catch (e) {
      TournamentService.rethrowSlugConflict(e);
    }
  }

  /** Reassign a tournament's game — allowed at any status (unlike updateTournament,
   *  which is OPEN-only). Lets staff attach a just-created game to a tournament that
   *  has been running under "General" (todo.md §5). Past awards already credited to
   *  the old game are not retroactively moved here; the dev backfill can rebuild
   *  per-game stats from history if a correction is wanted. */
  async reassignGame(id: string, gameId: string) {
    const tournament = await this.prisma.tournament.findUnique({ where: { id } });
    if (!tournament) throw new NotFoundException('Tournament not found');
    const game = await this.prisma.game.findUnique({ where: { id: gameId } });
    if (!game) throw new BadRequestException('Invalid gameId — game not found');

    return this.prisma.tournament.update({
      where: { id },
      data: { gameId },
      include: { format: true, game: true },
    });
  }

  // ─── BRACKET PREVIEW ─────────────────────────────────────────

  async generateBracket(tournamentId: string, user: JwtPayload) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: {
        participants: {
          include: {
            user: { select: { id: true, username: true, isGuest: true } },
          },
          orderBy: [{ seed: 'asc' }, { id: 'asc' }],
        },
      },
    });

    if (!tournament) throw new BadRequestException('Tournament not found');
    if (
      tournament.status !== TournamentStatus.PENDING &&
      tournament.status !== TournamentStatus.OPEN &&
      tournament.status !== TournamentStatus.UPCOMING
    ) {
      throw new BadRequestException(
        'Tournament must be PENDING, UPCOMING, or OPEN to generate bracket',
      );
    }
    if (tournament.participants.length < 2)
      throw new BadRequestException('Need at least 2 players');
    if (
      tournament.createdById !== user.id &&
      !user.roles.includes(Role.ADMIN)
    ) {
      throw new ForbiddenException(
        'Only the tournament organizer can generate the bracket',
      );
    }

    const participants = tournament.participants
      .filter((p) => p.user)
      .map((p) => ({ id: p.user.id, name: p.user.username }));

    const bracketSize = this.nextPowerOfTwo(participants.length);
    const matchups: {
      matchIndex: number;
      player1: (typeof participants)[0] | null;
      player2: (typeof participants)[0] | null;
    }[] = [];

    // Uses the same seeded placement the engine uses, so the preview shows the
    // bracket that will actually be created. Previously this paired adjacently
    // while the engine did too — but the frontend's own preview component used a
    // third, different algorithm, so no two of the three agreed.
    const slots = seedBracketSlots(participants, bracketSize);

    for (let i = 0; i < slots.length; i += 2) {
      matchups.push({
        matchIndex: i / 2 + 1,
        player1: slots[i] ?? null,
        player2: slots[i + 1] ?? null,
      });
    }

    return matchups;
  }

  private nextPowerOfTwo(n: number): number {
    let power = 1;
    while (power < n) power *= 2;
    return power;
  }

  // ─── START ───────────────────────────────────────────────────

  async startTournament(tournamentId: string) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: {
        // Ordered by seed, because this list becomes the bracket. Without the
        // orderBy the organizer's drag-to-reorder was silently discarded: the
        // seed column was written and persisted, generateBracket sorted by it,
        // but generateBracket is only the preview — THIS is the query that
        // actually builds the tournament, and it took rows in whatever order
        // Postgres returned them. Nulls last so unseeded players fill in behind
        // seeded ones rather than displacing them.
        participants: {
          include: { stats: true },
          orderBy: [{ seed: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
        },
        format: true,
        rounds: { where: { roundNumber: 1 }, include: { matches: true } },
      },
    });

    if (!tournament) throw new NotFoundException('Tournament not found');

    // Validate before claiming, so a rejected start never has to be undone.
    if (tournament.status !== TournamentStatus.OPEN)
      throw new BadRequestException('Tournament already started');
    if (tournament.participants.length < 2)
      throw new BadRequestException('Need at least 2 players');
    if (!tournament.format)
      throw new BadRequestException('Tournament has no format assigned');

    // Claim the start atomically. The check above is a fast path for a friendly
    // error; on its own it is a read-then-write race with a window as long as
    // bracket generation takes. That matters on a venue connection: an organizer
    // taps Start, the response never arrives, they tap again, and without this
    // both requests would generate their own bracket. Only one caller can move
    // the row out of OPEN, so only one generates.
    const claim = await this.prisma.tournament.updateMany({
      where: { id: tournamentId, status: TournamentStatus.OPEN },
      data: { status: TournamentStatus.ONGOING },
    });
    if (claim.count === 0) {
      throw new BadRequestException('Tournament already started');
    }

    // How the field is drawn. RANDOM is the default: an event draws its bracket
    // unless the organizer has deliberately arranged one. MANUAL honours the
    // seed column, which the query above already ordered by.
    //
    // Note this is a real behavioural default, not a no-op. Before it existed
    // the order was whatever Postgres returned — which correlates with insert
    // order, so the first player to register was consistently placed in the top
    // slot. That is neither a draw nor a seeding; it just rewarded registering
    // early.
    const { seedingMode } = resolveConfig(effectiveRawConfig(tournament));
    const orderedParticipants =
      seedingMode === 'MANUAL'
        ? tournament.participants
        : shuffled(tournament.participants);

    const playerIds = orderedParticipants.map((p) => p.userId);

    try {
      for (const participant of tournament.participants) {
        if (!participant.stats) {
          await this.prisma.tournamentParticipantStats.create({
            data: { participantId: participant.id },
          });
        }
      }

      // A round left over from a previous attempt is only reusable if it is
      // complete. A partial one is discarded and rebuilt rather than activated,
      // which is what the old code did - and once activated there was no way back,
      // since ONGOING only leads to COMPLETED.
      let firstRound: (typeof tournament.rounds)[number] | undefined =
        tournament.rounds[0];
      if (
        firstRound &&
        !this.isFirstRoundComplete(firstRound.matches, playerIds)
      ) {
        await this.discardGeneratedBracket(tournamentId);
        firstRound = undefined;
      }

      if (!firstRound) {
        await this.formatsService.initializeTournamentFormat(
          tournamentId,
          tournament.format,
          playerIds,
          false,
        );

        const updated = await this.prisma.tournament.findUnique({
          where: { id: tournamentId },
          include: {
            rounds: { where: { roundNumber: 1 }, include: { matches: true } },
          },
        });

        firstRound = updated?.rounds[0];

        // Verify before relying on it. Generation is many separate writes with no
        // transaction around them, so a failure partway leaves a half-built round
        // that looks valid until someone tries to play it.
        if (
          !firstRound ||
          !this.isFirstRoundComplete(firstRound.matches, playerIds)
        ) {
          throw new BadRequestException(
            'Bracket generation did not complete. No changes were kept — please try again.',
          );
        }
      }

      for (const match of firstRound.matches) {
        // Real, playable round-1 matches are left PENDING: the organizer starts
        // each one explicitly (POST /matches/:id/start). Nothing auto-activates any
        // more. Byes still resolve automatically — there is no game to start.
        if (match.isBye && (match.player1Id || match.player2Id)) {
          // Swiss / round-robin byes are already completed AND scored during
          // generation (creditBye), so only complete a bye that generation left
          // pending — an elimination bye. Re-writing a finished bye would clobber a
          // configured DRAW/NONE result, which records no winner, back into a win.
          if (match.status !== MatchStatus.COMPLETED) {
            const winnerId = (match.player1Id || match.player2Id) as string;
            await this.prisma.match.update({
              where: { id: match.id },
              data: { winnerId, status: MatchStatus.COMPLETED },
            });
          }
          await this.formatsService.handleMatchCompletion(match.id);
        }
      }
    } catch (error) {
      // Put the tournament back the way it was so the organizer can simply try
      // again. Without this the claim above would strand it in ONGOING with a
      // broken bracket and no transition out except COMPLETED.
      await this.discardGeneratedBracket(tournamentId);
      await this.prisma.tournament.updateMany({
        where: { id: tournamentId },
        data: { status: TournamentStatus.OPEN },
      });
      throw error;
    }

    // Already ONGOING from the claim; this re-write is harmless and is what emits
    // the refresh and sends the "tournament has started" notifications.
    await this.updateStatusInternal(tournamentId, TournamentStatus.ONGOING);
    return { message: 'Tournament started successfully' };
  }

  /**
   * Every player must appear exactly once in round one — as a paired player or as
   * the single player in a bye. That holds for every format the engine supports,
   * so it is a format-agnostic way to tell a finished bracket from a half-written
   * one without teaching this method how each bracket is shaped.
   */
  private isFirstRoundComplete(
    matches: { player1Id: string | null; player2Id: string | null }[],
    playerIds: string[],
  ): boolean {
    if (matches.length === 0) return false;

    const seen = new Set<string>();
    for (const match of matches) {
      for (const id of [match.player1Id, match.player2Id]) {
        if (!id) continue;
        if (seen.has(id)) return false; // a player placed twice
        seen.add(id);
      }
    }
    return playerIds.every((id) => seen.has(id));
  }

  /**
   * Removes every round and match of a tournament, for abandoning a bracket that
   * failed to generate. Deletion is ordered deliberately: matches point at each
   * other through nextMatchId/loserNextMatchId, and rounds cannot be removed
   * while their matches exist, so the links are cleared first, then the matches,
   * then the rounds.
   */
  private async discardGeneratedBracket(tournamentId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.match.updateMany({
        where: { round: { tournamentId } },
        data: { nextMatchId: null, loserNextMatchId: null },
      });
      await tx.match.deleteMany({ where: { round: { tournamentId } } });
      await tx.round.deleteMany({ where: { tournamentId } });
    });
  }

  // ─── COMPLETE ────────────────────────────────────────────────

  /**
   * Final placings used for global points and the placement notification.
   *
   * - Elimination: taken from the bracket (see computeStructuralPlacements).
   * - Hybrid: the top cut is placed structurally from phase 2; everyone who did
   *   not make the cut keeps their phase-1 Swiss order, ranked below the cut.
   *   Phase 1 exists to seed the cut, so its standings are the right answer for
   *   the players it eliminated.
   * - Swiss / round robin: unchanged — standings are the result.
   *
   * Falls back to the points order if the bracket yields nothing (an abandoned
   * or force-completed tournament with no completed matches), because a wrong
   * order is still better than no award at all.
   */
  private async resolveFinalPlacements<
    T extends { userId: string; rank: number },
  >(
    tournamentId: string,
    system: string | undefined,
    pointsLeaderboard: T[],
  ): Promise<T[]> {
    const isElimination =
      system === 'SINGLE_ELIMINATION' || system === 'DOUBLE_ELIMINATION';
    const isHybrid = system === 'HYBRID';
    if (!isElimination && !isHybrid) return pointsLeaderboard;

    const structural =
      await this.leaderboardService.computeStructuralPlacements(
        tournamentId,
        isHybrid ? 2 : undefined,
      );
    if (structural.size === 0) return pointsLeaderboard;

    if (isElimination) {
      return [...pointsLeaderboard]
        .map((e) => ({ ...e, rank: structural.get(e.userId) ?? e.rank }))
        .sort((a, b) => a.rank - b.rank);
    }

    // Hybrid: cut players take their bracket placing; the rest follow in
    // phase-1 order, starting below the whole cut.
    const cutSize = structural.size;
    let nextRank = cutSize;
    return [...pointsLeaderboard]
      .map((e) => {
        const placed = structural.get(e.userId);
        if (placed !== undefined) return { ...e, rank: placed };
        nextRank += 1;
        return { ...e, rank: nextRank };
      })
      .sort((a, b) => a.rank - b.rank);
  }

  async completeTournament(tournamentId: string) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: {
        participants: { include: { user: true } },
        rounds: {
          include: {
            matches: {
              include: { player1: true, player2: true, winner: true },
            },
          },
        },
      },
    });

    if (!tournament) throw new NotFoundException('Tournament not found');

    // Idempotency guard. Everything below increments lifetime counters
    // (tournamentsPlayed, tournamentsWon, globalPoints) with no way to undo them,
    // so a second call would permanently inflate the global leaderboard. This is
    // reachable in normal use: an organizer can finalize a tournament that still
    // has pending matches, and completing one of those later re-triggers
    // checkTournamentComplete.
    if (tournament.status === TournamentStatus.COMPLETED) {
      return { message: 'Tournament already completed. No changes made.' };
    }

    // F10. On a normal completion the winner is already set (the format's own
    // completion check writes it before calling here). On a MANUAL early
    // completion it can be null — it is finalized from the resolved final
    // placements below, so the champion still gets tournamentsWon, a winner name,
    // and exclusion from guest cleanup. guestUserIds is likewise computed after
    // that, so a derived guest winner is not scheduled for removal.
    let winnerId = tournament.winnerId;

    const registeredParticipants = tournament.participants.filter(
      (p) => p.user && !p.user.isGuest,
    );

    // ─── Reads and pure computation, before the transaction opens ────
    // Nothing below this point that only reads belongs inside the transaction:
    // it would hold locks for longer with no consistency benefit. The leaderboard
    // is read here too - it depends on match results and per-tournament stats,
    // neither of which this method changes.
    const tournamentWithFormat = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: { format: true, game: { select: { name: true } } },
    });
    // Per-game credit routes by the tournament's own game (todo.md §5) — every
    // tournament has one (the "General" floor), so unlike the old format-derived
    // path this is (almost) never null. The format.gameName fallback only covers
    // legacy rows not yet backfilled to a game.
    const gameName =
      tournamentWithFormat?.game?.name ??
      tournamentWithFormat?.format?.gameName ??
      null;

    const rawConfig = effectiveRawConfig(tournamentWithFormat);
    const config = resolveConfig(rawConfig);
    const {
      placementPointsChampion,
      placementPoints2nd,
      placementPoints3rd,
      placementPointsTopCut,
      placementPointsParticipation,
    } = config;
    const isHybrid = tournamentWithFormat?.format?.system === 'HYBRID';

    const system = tournamentWithFormat?.format?.system;

    const pointsLeaderboard =
      await this.leaderboardService.getLeaderboard(tournamentId);

    // Plan 8.2/8.3. Placement drives both the global points award and the
    // "You placed #N" notification. Ranking on accumulated match points is only
    // *accidentally* right in single elimination, where wins happen to track
    // rounds survived. It breaks wherever those decouple:
    //   - double elimination, where a long losers-bracket run piles up wins;
    //   - hybrid, where a 5-0 Swiss player who then LOSES the final can finish
    //     on more points than the player who won it — so the runner-up was paid
    //     the champion's points while the tournament recorded the real winner
    //     (the confirmed bug in 8b).
    // For a bracket, placement is decided by who won, so it is read from the
    // bracket. Swiss and round robin are unchanged: there, standings ARE the
    // result.
    const leaderboard = await this.resolveFinalPlacements(
      tournamentId,
      system,
      pointsLeaderboard,
    );

    // F10. Finalize the winner when it was never set (manual early completion):
    // the top of the resolved final placements is the champion. Persisted in the
    // transaction below alongside the winner-name snapshot.
    if (!winnerId) winnerId = leaderboard[0]?.userId ?? null;

    const guestUserIds = tournament.participants
      .filter((p) => p.user.isGuest && p.user.id !== winnerId)
      .map((p) => p.user.id);

    const cleanupTime = new Date();
    cleanupTime.setDate(
      cleanupTime.getDate() + TournamentService.GUEST_EXPIRY_DAYS,
    );

    // Notifications are collected rather than sent, because a message cannot be
    // recalled if the transaction below rolls back. They go out after the commit.
    const pendingNotifications: NotifyInput[] = [];

    if (tournament.createdById) {
      pendingNotifications.push({
        userId: tournament.createdById,
        type: NotificationType.GUEST_CLEANUP_SCHEDULED,
        title: 'Guest accounts scheduled for removal',
        body: `Guest accounts from ${tournament.name} will be deleted. Cancel from the manage page if you still need them.`,
        link: `/tournaments/${tournamentId}/manage`,
        tournamentId,
      });
    }

    // ─── Every write, as one unit ────────────────────────────────────
    // These award lifetime counters and points that nothing recomputes, so a
    // half-applied run is silently and permanently wrong. The generous timeout is
    // deliberate: a 128-player tournament snapshots ~127 match names and upserts
    // stats for every participant, which comfortably exceeds Prisma's 5s default.
    await this.prisma.$transaction(
      async (tx) => {
        // Inlined rather than calling updateStatusInternal, which also emits over
        // the socket. For COMPLETED that helper sends no notifications anyway, so
        // this is equivalent minus the side effect. The emit happens after commit.
        await tx.tournament.update({
          where: { id: tournamentId },
          data: { status: TournamentStatus.COMPLETED },
        });

        // Snapshot match player names before guest purge
        for (const round of tournament.rounds) {
          for (const match of round.matches) {
            await tx.match.update({
              where: { id: match.id },
              data: {
                p1Name: match.player1?.username || match.p1Name,
                p2Name: match.player2?.username || match.p2Name,
                winnerName: match.winner?.username || match.winnerName,
              },
            });
          }
        }

        // Snapshot tournament winner name — and persist winnerId itself, which may
        // have been derived from placement here on a manual early completion (F10).
        if (winnerId) {
          const winner = tournament.participants.find(
            (p) => p.userId === winnerId,
          )?.user;
          await tx.tournament.update({
            where: { id: tournamentId },
            data: {
              winnerId,
              winnerName: winner?.username || 'Unknown',
            } as any,
          });
        }

        await tx.tournament.update({
          where: { id: tournamentId },
          data: { guestCleanupAt: cleanupTime },
        });

        if (guestUserIds.length > 0) {
          await tx.user.updateMany({
            where: { id: { in: guestUserIds }, isGuest: true },
            data: { expiresAt: cleanupTime, isExpired: false },
          });
        }

        for (const participant of registeredParticipants) {
          await tx.userGlobalStats.upsert({
            where: { userId: participant.userId },
            create: {
              userId: participant.userId,
              tournamentsPlayed: 1,
              tournamentsWon: 0,
              gamesPlayed: 0,
              wins: 0,
              losses: 0,
              draws: 0,
              winRate: 0,
            },
            update: {
              tournamentsPlayed: { increment: 1 },
            },
          });

          if (gameName) {
            await tx.userGameStats.upsert({
              where: {
                userId_gameName: { userId: participant.userId, gameName },
              },
              create: {
                userId: participant.userId,
                gameName,
                tournamentsPlayed: 1,
              },
              update: {
                tournamentsPlayed: { increment: 1 },
              },
            });
          }
        }

        if (winnerId) {
          const winner = tournament.participants.find(
            (p) => p.userId === winnerId,
          );
          if (winner && winner.user && !winner.user.isGuest) {
            await tx.userGlobalStats.upsert({
              where: { userId: winnerId },
              create: {
                userId: winnerId,
                tournamentsPlayed: 1,
                tournamentsWon: 1,
                gamesPlayed: 0,
                wins: 0,
                losses: 0,
                draws: 0,
                winRate: 0,
              },
              update: {
                tournamentsWon: { increment: 1 },
              },
            });

            if (gameName) {
              await tx.userGameStats.upsert({
                where: { userId_gameName: { userId: winnerId, gameName } },
                create: {
                  userId: winnerId,
                  gameName,
                  tournamentsPlayed: 1,
                  tournamentsWon: 1,
                },
                update: {
                  tournamentsWon: { increment: 1 },
                },
              });
            }
          }
        }

        // ─── Award placement-based global points ─────────────────────
        for (const entry of leaderboard) {
          const participant = registeredParticipants.find(
            (p) => p.userId === entry.userId,
          );
          if (!participant) continue; // skip guests

          let pts: number;
          if (entry.rank === 1) pts = placementPointsChampion;
          else if (entry.rank === 2) pts = placementPoints2nd;
          else if (entry.rank === 3) pts = placementPoints3rd;
          else if (isHybrid) pts = placementPointsTopCut;
          else pts = placementPointsParticipation;

          await tx.userGlobalStats.upsert({
            where: { userId: entry.userId },
            create: {
              userId: entry.userId,
              tournamentsPlayed: 0,
              tournamentsWon: 0,
              gamesPlayed: 0,
              wins: 0,
              losses: 0,
              draws: 0,
              winRate: 0,
              globalPoints: pts,
            },
            update: {
              globalPoints: { increment: pts },
            },
          });

          // The placement notification is the only message sent for completion -
          // updateStatusInternal deliberately stays quiet for COMPLETED, because
          // this one says more.
          pendingNotifications.push({
            userId: entry.userId,
            type: NotificationType.TOURNAMENT_PLACEMENT,
            title: `You placed #${entry.rank} in ${tournament.name}`,
            link: `/tournaments/${tournamentId}`,
            tournamentId,
          });

          if (gameName) {
            await tx.userGameStats.upsert({
              where: { userId_gameName: { userId: entry.userId, gameName } },
              create: {
                userId: entry.userId,
                gameName,
                globalPoints: pts,
              },
              update: {
                globalPoints: { increment: pts },
              },
            });
          }
        }
      },
      { timeout: 30000, maxWait: 10000 },
    );

    // ─── Side effects, only once the writes are durable ──────────────
    this.realtime.emitTournamentUpdated(tournamentId);
    for (const notification of pendingNotifications) {
      await this.notifications.notify(notification);
    }

    return { message: 'Tournament data cleaned up. Winner preserved.' };
  }

  async cancelCleanup(tournamentId: string) {
    return this.prisma.tournament.update({
      where: { id: tournamentId },
      data: { guestCleanupAt: null },
    });
  }

  async resolveTie(
    tournamentId: string,
    action: 'EXTEND_ROUND' | 'APPLY_TIEBREAKERS',
  ) {
    return this.formatsService.resolveTie(tournamentId, action);
  }

  // ─── GET ONE ─────────────────────────────────────────────────

  /**
   * Plan 7.1. `rounds` — every round, every match, three joined users per match —
   * is what makes this response scale badly: measured at 7.7 KB for 8 players
   * but 106.8 KB for 128, and every live view refetches the whole thing on every
   * socket signal and every poll tick.
   *
   * `summary` omits it. Screens that only need the tournament and its roster
   * (the lobby, the detail header) pass it and stop paying for a bracket they do
   * not draw; anything that needs matches either omits it or uses the dedicated
   * GET /tournaments/:id/rounds. Opt-in rather than opt-out so no existing
   * caller silently loses data.
   */
  async getTournament(
    tournamentId: string,
    user?: JwtPayload,
    view: 'full' | 'summary' = 'full',
  ) {
    const roundsInclude = {
      orderBy: { roundNumber: 'asc' as const },
      include: {
        matches: {
          include: {
            player1: {
              select: { id: true, username: true, isGuest: true },
            },
            player2: {
              select: { id: true, username: true, isGuest: true },
            },
            winner: { select: { id: true, username: true, isGuest: true } },
          },
        },
      },
    };

    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: {
        // No email in the public tournament read — GET /tournaments/:id and the
        // invite route are unauthenticated, so exposing creator/participant emails
        // let anyone with a tournament id enumerate them. Managers who need contact
        // details use GET /auth/users (organizer/admin only).
        createdBy: { select: { id: true, username: true } },
        winner: { select: { id: true, username: true, isGuest: true } },
        format: true,
        game: { select: { id: true, name: true, iconUrl: true } },
        participants: {
          include: {
            user: {
              select: { id: true, username: true, isGuest: true },
            },
          },
        },
        ...(view === 'summary' ? {} : { rounds: roundsInclude }),
      },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');

    // Computed per request, never stored. The frontend gates its management
    // controls on this instead of on the viewer's role, so what it renders
    // matches what the guards will actually permit.
    const access = await checkTournamentAccess(this.prisma, tournamentId, user);
    return { ...tournament, canManage: access === 'ALLOWED' };
  }

  async getTournamentByInviteToken(inviteToken: string) {
    // The link path accepts either the short slug ("summer-cup") or the
    // original long UUID token, so links shared before a slug existed
    // keep working forever.
    const tournament = await this.prisma.tournament.findFirst({
      where: { OR: [{ slug: inviteToken }, { inviteToken }] },
      include: {
        // No email in the public tournament read — GET /tournaments/:id and the
        // invite route are unauthenticated, so exposing creator/participant emails
        // let anyone with a tournament id enumerate them. Managers who need contact
        // details use GET /auth/users (organizer/admin only).
        createdBy: { select: { id: true, username: true } },
        winner: { select: { id: true, username: true, isGuest: true } },
        format: true,
        game: { select: { id: true, name: true, iconUrl: true } },
        participants: {
          include: {
            user: {
              select: { id: true, username: true, isGuest: true },
            },
          },
        },
        rounds: {
          orderBy: { roundNumber: 'asc' },
          include: {
            matches: {
              include: {
                player1: {
                  select: { id: true, username: true, isGuest: true },
                },
                player2: {
                  select: { id: true, username: true, isGuest: true },
                },
                winner: { select: { id: true, username: true, isGuest: true } },
              },
            },
          },
        },
      },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');
    return tournament;
  }

  // ─── GET ALL ─────────────────────────────────────────────────

  async getAllTournaments(
    user?: JwtPayload,
    manageableOnly = false,
  ): Promise<Tournament[]> {
    // Auto-purge expired guests
    const now = new Date();
    const expired = await this.prisma.user.findMany({
      where: {
        isGuest: true,
        OR: [{ isExpired: true }, { expiresAt: { lte: now } }],
      },
      select: { id: true },
    });
    if (expired.length > 0) {
      await this.prisma.user.updateMany({
        where: { id: { in: expired.map((u) => u.id) } },
        data: { isExpired: true },
      });
    }

    // Auto-open scheduled tournaments
    await this.prisma.tournament.updateMany({
      where: { status: TournamentStatus.UPCOMING, date: { lte: new Date() } },
      data: { status: TournamentStatus.OPEN },
    });

    // Filtering has to happen server-side: access is not always derivable from
    // fields the client can see, so a client-side createdById filter would be
    // both duplicated logic and wrong as soon as access can be granted any other
    // way. Admins see everything, so they are not filtered.
    const manageableWhere =
      manageableOnly && user && !user.roles?.includes(Role.ADMIN)
        ? {
            OR: [
              { createdById: user.id },
              {
                organizers: {
                  some: {
                    userId: user.id,
                    status: OrganizerInviteStatus.ACCEPTED,
                  },
                },
              },
            ],
          }
        : undefined;

    // Plan 9.15. `isPrivate` was written by the create form and then filtered on
    // by nothing at all, so a tournament offered as "Private Invite" appeared in
    // the public list for everyone. That is a disclosure expectation the UI
    // created and the backend did not honour.
    //
    // Private means UNLISTED, not inaccessible: the whole point is that the
    // invite link still works, so GET /tournaments/:id and the invite route are
    // deliberately left open. Only the browse list is filtered, and it still
    // shows a private tournament to people who have a reason to see it — an
    // admin, its creator, an accepted co-organizer, or someone already entered.
    const privacyWhere =
      user?.roles?.includes(Role.ADMIN)
        ? undefined
        : {
            OR: [
              { isPrivate: false },
              ...(user
                ? [
                    { createdById: user.id },
                    {
                      organizers: {
                        some: {
                          userId: user.id,
                          status: OrganizerInviteStatus.ACCEPTED,
                        },
                      },
                    },
                    { participants: { some: { userId: user.id } } },
                  ]
                : []),
            ],
          };

    const where =
      manageableWhere && privacyWhere
        ? { AND: [manageableWhere, privacyWhere] }
        : (manageableWhere ?? privacyWhere);

    return this.prisma.tournament.findMany({
      ...(where ? { where } : {}),
      orderBy: { createdAt: 'desc' },
      include: {
        winner: { select: { username: true, isGuest: true } },
        format: true,
        game: { select: { id: true, name: true, iconUrl: true } },
        participants: true,
        rounds: {
          orderBy: { roundNumber: 'desc' },
          take: 1,
          include: {
            matches: {
              include: {
                winner: { select: { username: true, isGuest: true } },
              },
            },
          },
        },
      },
    });
  }
}
