import { Prisma } from '@prisma/client';
import { systemOf, type ByeResult } from '../../Formats/format-config.helper';

/**
 * Single authority for what a completed match credits (and what uncredits).
 *
 * `MatchService.updateMatchStats` grants a completed match to
 * TournamentParticipantStats, UserGlobalStats and the per-game bucket with
 * `direction = 1`. `TournamentService.deleteTournament` reverses the exact same
 * deltas with `direction = -1` before it deletes the rows, and `resetMatch`
 * reverses with `direction = -1` when a result is taken back. Keeping one
 * implementation for grant and revoke is what guarantees a reset or a delete
 * can never leave phantom wins/games behind again.
 */
export async function applyMatchStats(
  tx: Prisma.TransactionClient,
  matchId: string,
  pointsConfig: {
    pointsForWin: number;
    pointsForDraw: number;
    pointsForLoss: number;
  },
  // How a bye match credits its player. Only consulted when match.isBye; a real
  // result ignores it. Defaults to WIN so every existing grant caller is
  // unchanged.
  byeResult: ByeResult = 'WIN',
  // 1 = grant (MatchService), -1 = revoke (reset / tournament delete).
  direction: 1 | -1 = 1,
  // Walkover mode: only the winner is credited (and only the winner reversed).
  // A walkover is not a game the loser played, so the loser gets NO game
  // counter and NO result — see creditWalkoverWin. Points never apply.
  winnerOnly = false,
) {
  // One transaction: this credits BOTH players. Half-applied, one player
  // has the match on their record and the other does not, and nothing
  // recomputes to notice. Every step is a plain write, so none of it needs
  // to sit outside.
  const match = await tx.match.findUnique({
    where: { id: matchId },
    include: {
      round: {
        select: {
          tournamentId: true,
          tournament: {
            select: { system: true, format: { select: { system: true } } },
          },
        },
      },
      player1: { select: { id: true, isGuest: true } },
      player2: { select: { id: true, isGuest: true } },
    },
  });

  if (!match || !match.round || !match.player1Id) return;

  // Match points are the result only where standings ARE the result. On a
  // bracket the result is who won: awarding points per win actively caused harm
  // (a hybrid paying the runner-up the champion's global points; double
  // elimination halting on a phantom "tie for 1st"). Win/loss/draw counters are
  // deliberately NOT skipped — a win/loss record matters in every system and
  // feeds UserGlobalStats. Only the points component is zeroed.
  const system = systemOf(match.round.tournament);
  const pointsApply = !(
    system === 'SINGLE_ELIMINATION' ||
    system === 'DOUBLE_ELIMINATION' ||
    (system === 'HYBRID' && match.phase === 2)
  );
  // A walkover carries no points anywhere (mirrors creditWalkoverWin).
  const points = !winnerOnly && pointsApply
    ? pointsConfig
    : { pointsForWin: 0, pointsForDraw: 0, pointsForLoss: 0 };

  const participantIds = [match.player1Id, match.player2Id].filter(
    Boolean,
  ) as string[];
  const participants = await tx.tournamentParticipant.findMany({
    where: {
      tournamentId: match.round.tournamentId,
      userId: { in: participantIds },
    },
    include: {
      stats: true,
      user: { select: { isGuest: true } },
    },
  });

  const participantByUserId = new Map(
    participants.map((participant) => [participant.userId, participant]),
  );

  // Game bucket for per-game stats — the tournament's own game, with the
  // format's gameName as a legacy fallback for un-backfilled rows.
  const tournamentMeta = await tx.tournament.findUnique({
    where: { id: match.round.tournamentId },
    select: {
      game: { select: { name: true } },
      format: { select: { gameName: true } },
    },
  });
  const gameName =
    tournamentMeta?.game?.name ?? tournamentMeta?.format?.gameName ?? null;

  const floor = (value: number) => Math.max(0, value);

  const maybeUpdateGlobalStats = async (
    userId: string,
    isGuest: boolean,
    deltaGames: number,
    deltaWins: number,
    deltaLosses: number,
    deltaDraws: number,
  ) => {
    if (isGuest) return;

    const currentGlobal = await tx.userGlobalStats.findUnique({
      where: { userId },
    });
    // Reversal with nothing to reverse must not mint an empty/negative row.
    if (!currentGlobal && direction < 0) return;

    const gamesPlayed = floor((currentGlobal?.gamesPlayed ?? 0) + deltaGames);
    const wins = floor((currentGlobal?.wins ?? 0) + deltaWins);
    const losses = floor((currentGlobal?.losses ?? 0) + deltaLosses);
    const draws = floor((currentGlobal?.draws ?? 0) + deltaDraws);
    const winRate = gamesPlayed > 0 ? wins / gamesPlayed : 0;

    if (currentGlobal) {
      await tx.userGlobalStats.update({
        where: { userId },
        data: { gamesPlayed, wins, losses, draws, winRate },
      });
    } else {
      await tx.userGlobalStats.create({
        data: {
          userId,
          tournamentsPlayed: 0,
          tournamentsWon: 0,
          gamesPlayed,
          wins,
          losses,
          draws,
          winRate,
        },
      });
    }

    if (!gameName) return;

    const currentGame = await tx.userGameStats.findUnique({
      where: { userId_gameName: { userId, gameName } },
    });
    if (!currentGame && direction < 0) return;

    const gameGamesPlayed = floor(
      (currentGame?.gamesPlayed ?? 0) + deltaGames,
    );
    const gameWins = floor((currentGame?.wins ?? 0) + deltaWins);
    const gameLosses = floor((currentGame?.losses ?? 0) + deltaLosses);
    const gameDraws = floor((currentGame?.draws ?? 0) + deltaDraws);
    const gameWinRate = gameGamesPlayed > 0 ? gameWins / gameGamesPlayed : 0;

    await tx.userGameStats.upsert({
      where: { userId_gameName: { userId, gameName } },
      create: {
        userId,
        gameName,
        gamesPlayed: gameGamesPlayed,
        wins: gameWins,
        losses: gameLosses,
        draws: gameDraws,
        winRate: gameWinRate,
      },
      update: {
        gamesPlayed: gameGamesPlayed,
        wins: gameWins,
        losses: gameLosses,
        draws: gameDraws,
        winRate: gameWinRate,
      },
    });
  };

  const updateParticipant = async (
    userId: string,
    deltaGames: number,
    deltaWins: number,
    deltaLosses: number,
    deltaDraws: number,
    deltaPoints: number,
  ) => {
    const participant = participantByUserId.get(userId);
    if (!participant) return;

    let stats = participant.stats;
    // Reversal of a participant with no per-tournament stats row (e.g. the
    // grant predates the row, or it was already removed) has nothing to roll
    // back — don't mint a fresh row that would just go negative.
    if (!stats) {
      if (direction < 0) return;
      stats = await tx.tournamentParticipantStats.create({
        data: { participantId: participant.id },
      });
    }

    const gamesPlayed = floor(stats.gamesPlayed + deltaGames);
    const wins = floor(stats.wins + deltaWins);
    const losses = floor(stats.losses + deltaLosses);
    const draws = floor(stats.draws + deltaDraws);
    const winRate = gamesPlayed > 0 ? wins / gamesPlayed : 0;

    await tx.tournamentParticipantStats.update({
      where: { id: stats.id },
      data: {
        gamesPlayed,
        wins,
        losses,
        draws,
        points: { increment: deltaPoints },
        winRate,
      },
    });

    await maybeUpdateGlobalStats(
      userId,
      participant.user.isGuest,
      deltaGames,
      deltaWins,
      deltaLosses,
      deltaDraws,
    );
  };

  const d = direction;

  if (match.isBye) {
    // A bye credits its player per the configured byeResult. WIN is the
    // standard and the default; DRAW records a draw's points; NONE credits
    // nothing (the match still stands as a completed bye, just uncounted).
    if (byeResult === 'NONE') return;
    if (byeResult === 'DRAW') {
      await updateParticipant(
        match.player1Id,
        d * 1,
        d * 0,
        d * 0,
        d * 1,
        points.pointsForDraw * d,
      );
    } else {
      await updateParticipant(
        match.player1Id,
        d * 1,
        d * 1,
        d * 0,
        d * 0,
        points.pointsForWin * d,
      );
    }
    return;
  }

  if (!match.player2Id) return;

  // Walkover: only the winner gets +1 game / +1 win (no points, and the loser
  // is left entirely untouched — they never played, mirroring creditWalkoverWin).
  if (winnerOnly) {
    if (!match.winnerId) return;
    const winnerUserId =
      match.winnerId === match.player1Id ? match.player1Id : match.player2Id;
    await updateParticipant(
      winnerUserId,
      d * 1,
      d * 1,
      d * 0,
      d * 0,
      0,
    );
    return;
  }

  if (!match.winnerId) {
    await Promise.all([
      updateParticipant(
        match.player1Id,
        d * 1,
        d * 0,
        d * 0,
        d * 1,
        points.pointsForDraw * d,
      ),
      updateParticipant(
        match.player2Id,
        d * 1,
        d * 0,
        d * 0,
        d * 1,
        points.pointsForDraw * d,
      ),
    ]);
    return;
  }

  if (match.winnerId === match.player1Id) {
    await Promise.all([
      updateParticipant(
        match.player1Id,
        d * 1,
        d * 1,
        d * 0,
        d * 0,
        points.pointsForWin * d,
      ),
      updateParticipant(
        match.player2Id,
        d * 1,
        d * 0,
        d * 1,
        d * 0,
        points.pointsForLoss * d,
      ),
    ]);
    return;
  }

  await Promise.all([
    updateParticipant(
      match.player1Id,
      d * 1,
      d * 0,
      d * 1,
      d * 0,
      points.pointsForLoss * d,
    ),
    updateParticipant(
      match.player2Id,
      d * 1,
      d * 1,
      d * 0,
      d * 0,
      points.pointsForWin * d,
    ),
  ]);
}