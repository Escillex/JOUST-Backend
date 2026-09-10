-- Admin analytics (2026-09-10): record WHEN a tournament finished.
-- `status = COMPLETED` is a flag with no time attached, so no completion could be
-- placed on a timeline. completeTournament now stamps this going forward.

-- AlterTable
ALTER TABLE "Tournament" ADD COLUMN "completedAt" TIMESTAMP(3);

-- Backfill: for tournaments already COMPLETED, the closest honest signal is the
-- last game logged in the event. Tournaments completed without any tracker log
-- stay NULL rather than being given an invented date — the analytics endpoint
-- counts those separately instead of pretending they finished at creation time.
UPDATE "Tournament" t
SET "completedAt" = sub.last_game
FROM (
  SELECT r."tournamentId" AS tid, MAX(g."completedAt") AS last_game
  FROM "MatchGameLog" g
  JOIN "Match" m ON m."id" = g."matchId"
  JOIN "Round" r ON r."id" = m."roundId"
  WHERE g."completedAt" IS NOT NULL
  GROUP BY r."tournamentId"
) sub
WHERE t."id" = sub.tid AND t."status" = 'COMPLETED';

-- CreateIndex
CREATE INDEX "Tournament_completedAt_idx" ON "Tournament"("completedAt");
