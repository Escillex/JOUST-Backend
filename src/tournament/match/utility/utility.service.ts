import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { randomInt } from 'crypto';
import { PrismaService } from 'prisma/prisma.service';
import { RealtimeGateway } from '../../../realtime/realtime.gateway';
import { JwtPayload } from '../../../guards/jwt-auth.guard';
import { checkTournamentAccess } from '../../../guards/tournament-access.util';
import {
  effectiveRawConfig,
  resolveConfig,
  UtilityPerm,
} from '../../../Formats/format-config.helper';
import { RollDiceDto, TimerActionDto } from './dto/utility.dto';

/** A coin/dice result keyed by the userId who triggered it. */
export interface FlipEntry {
  kind: 'COIN' | 'DICE';
  result: string; // "Heads" / "Tails" / "4" / "3, 6"
  at: string; // ISO
}

@Injectable()
export class MatchUtilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** Loads the match with the pieces every action needs: the two players, the
   *  tournament (for config + access), and the current utility row. */
  private async loadContext(matchId: string) {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: {
        id: true,
        player1Id: true,
        player2Id: true,
        round: {
          select: {
            tournament: {
              select: {
                id: true,
                config: true,
                format: { select: { config: true } },
              },
            },
          },
        },
        utilityState: true,
      },
    });
    if (!match) throw new NotFoundException('Match not found');
    const tournament = match.round?.tournament;
    if (!tournament) throw new NotFoundException('Match has no tournament');
    const config = resolveConfig(effectiveRawConfig(tournament), undefined);
    return { match, tournament, config };
  }

  /** Whether `user` satisfies `perm` for this match. STAFF = tournament staff
   *  (creator/admin/co-organizer); PARTICIPANTS = one of the two match players;
   *  the combined form allows either. NONE always denies. Mirrors the tracker's
   *  own-match-or-staff model, but the required role comes from config. */
  private async isAllowed(
    perm: UtilityPerm,
    tournamentId: string,
    player1Id: string | null,
    player2Id: string | null,
    user: JwtPayload,
  ): Promise<boolean> {
    if (perm === 'NONE') return false;
    const isParticipant =
      !!user?.id && (user.id === player1Id || user.id === player2Id);
    const staffAllowed = perm === 'STAFF' || perm === 'STAFF_AND_PARTICIPANTS';
    const participantAllowed =
      perm === 'PARTICIPANTS' || perm === 'STAFF_AND_PARTICIPANTS';
    if (participantAllowed && isParticipant) return true;
    if (staffAllowed) {
      return (
        (await checkTournamentAccess(this.prisma, tournamentId, user)) ===
        'ALLOWED'
      );
    }
    return false;
  }

  /** Reads `flips` JSON into a typed map. */
  private readFlips(raw: unknown): Record<string, FlipEntry> {
    return raw && typeof raw === 'object'
      ? (raw as Record<string, FlipEntry>)
      : {};
  }

  /** Public state for a match: the timer + per-player flips + the resolved perms
   *  the client uses to decide which triggers to show. No auth — spectators read
   *  it (same as the tracker GET). */
  async getState(matchId: string) {
    const { match, config } = await this.loadContext(matchId);
    return this.serialize(matchId, match.utilityState, config.utilities);
  }

  private serialize(
    matchId: string,
    state: {
      timerDurationSec: number | null;
      timerEndsAt: Date | null;
      timerRunning: boolean;
      timerPausedRemainingSec: number | null;
      flips: unknown;
    } | null,
    perms: {
      enabled: boolean;
      coinWho: UtilityPerm;
      diceWho: UtilityPerm;
      timerWho: UtilityPerm;
    },
  ) {
    return {
      matchId,
      perms,
      timer: {
        durationSec: state?.timerDurationSec ?? null,
        endsAt: state?.timerEndsAt ? state.timerEndsAt.toISOString() : null,
        running: state?.timerRunning ?? false,
        pausedRemainingSec: state?.timerPausedRemainingSec ?? null,
      },
      flips: this.readFlips(state?.flips),
    };
  }

  /** Upsert the utility row and broadcast the fresh state. */
  private async persistAndBroadcast(
    matchId: string,
    tournamentId: string,
    perms: {
      enabled: boolean;
      coinWho: UtilityPerm;
      diceWho: UtilityPerm;
      timerWho: UtilityPerm;
    },
    data: Record<string, unknown>,
  ) {
    const row = await this.prisma.matchUtilityState.upsert({
      where: { matchId },
      create: { matchId, ...data },
      update: data,
    });
    const payload = this.serialize(matchId, row, perms);
    this.realtime.emitUtilityUpdate(tournamentId, { matchId, state: payload });
    return payload;
  }

  async flipCoin(matchId: string, user: JwtPayload) {
    const { match, tournament, config } = await this.loadContext(matchId);
    if (!config.utilities.enabled)
      throw new ForbiddenException(
        'Match utilities are disabled for this tournament',
      );
    const ok = await this.isAllowed(
      config.utilities.coinWho,
      tournament.id,
      match.player1Id,
      match.player2Id,
      user,
    );
    if (!ok) throw new ForbiddenException('You are not allowed to flip here');

    const result = randomInt(2) === 0 ? 'Heads' : 'Tails';
    return this.recordFlip(
      matchId,
      tournament.id,
      config.utilities,
      match.utilityState?.flips,
      user.id,
      {
        kind: 'COIN',
        result,
        at: new Date().toISOString(),
      },
    );
  }

  async rollDice(matchId: string, dto: RollDiceDto, user: JwtPayload) {
    const { match, tournament, config } = await this.loadContext(matchId);
    if (!config.utilities.enabled)
      throw new ForbiddenException(
        'Match utilities are disabled for this tournament',
      );
    const ok = await this.isAllowed(
      config.utilities.diceWho,
      tournament.id,
      match.player1Id,
      match.player2Id,
      user,
    );
    if (!ok) throw new ForbiddenException('You are not allowed to roll here');

    const sides = dto.sides ?? 6;
    const count = dto.count ?? 1;
    const values = Array.from({ length: count }, () => randomInt(sides) + 1);
    return this.recordFlip(
      matchId,
      tournament.id,
      config.utilities,
      match.utilityState?.flips,
      user.id,
      {
        kind: 'DICE',
        result: values.join(', '),
        at: new Date().toISOString(),
      },
    );
  }

  private async recordFlip(
    matchId: string,
    tournamentId: string,
    perms: {
      enabled: boolean;
      coinWho: UtilityPerm;
      diceWho: UtilityPerm;
      timerWho: UtilityPerm;
    },
    existingFlips: unknown,
    userId: string,
    entry: FlipEntry,
  ) {
    const flips = this.readFlips(existingFlips);
    flips[userId] = entry;
    return this.persistAndBroadcast(matchId, tournamentId, perms, {
      flips: flips as object,
    });
  }

  async timer(matchId: string, dto: TimerActionDto, user: JwtPayload) {
    const { match, tournament, config } = await this.loadContext(matchId);
    if (!config.utilities.enabled)
      throw new ForbiddenException(
        'Match utilities are disabled for this tournament',
      );
    const ok = await this.isAllowed(
      config.utilities.timerWho,
      tournament.id,
      match.player1Id,
      match.player2Id,
      user,
    );
    if (!ok)
      throw new ForbiddenException('You are not allowed to control the timer');

    const state = match.utilityState;
    let data: Record<string, unknown>;

    switch (dto.action) {
      case 'set': {
        if (!dto.durationSec)
          throw new BadRequestException(
            'durationSec is required to set the timer',
          );
        data = {
          timerDurationSec: dto.durationSec,
          timerPausedRemainingSec: dto.durationSec,
          timerEndsAt: null,
          timerRunning: false,
          timerNotified: false,
        };
        break;
      }
      case 'start': {
        // Resume from paused remaining, or from a duration provided/held now.
        const remaining =
          dto.durationSec ??
          state?.timerPausedRemainingSec ??
          state?.timerDurationSec;
        if (!remaining)
          throw new BadRequestException(
            'Set a duration before starting the timer',
          );
        data = {
          timerDurationSec:
            dto.durationSec ?? state?.timerDurationSec ?? remaining,
          timerEndsAt: new Date(Date.now() + remaining * 1000),
          timerRunning: true,
          timerPausedRemainingSec: null,
          timerNotified: false,
        };
        break;
      }
      case 'pause': {
        // Freeze the remaining time so it can resume later.
        const remaining = state?.timerEndsAt
          ? Math.max(
              0,
              Math.round((state.timerEndsAt.getTime() - Date.now()) / 1000),
            )
          : (state?.timerPausedRemainingSec ?? 0);
        data = {
          timerRunning: false,
          timerPausedRemainingSec: remaining,
          timerEndsAt: null,
        };
        break;
      }
      case 'reset': {
        const dur = state?.timerDurationSec ?? null;
        data = {
          timerRunning: false,
          timerEndsAt: null,
          timerPausedRemainingSec: dur,
          timerNotified: false,
        };
        break;
      }
    }

    return this.persistAndBroadcast(
      matchId,
      tournament.id,
      config.utilities,
      data,
    );
  }
}
