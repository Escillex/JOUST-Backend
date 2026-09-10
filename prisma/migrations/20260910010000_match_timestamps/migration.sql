-- Operational analytics (2026-09-10): record when a match actually started and
-- ended. `createdAt` is when the bracket was generated, so no duration or stall
-- metric could be derived from it.

-- AlterTable
ALTER TABLE "Match" ADD COLUMN "startedAt" TIMESTAMP(3);
ALTER TABLE "Match" ADD COLUMN "completedAt" TIMESTAMP(3);

-- Backfill from the live tracker's game logs, the only historical record of play:
-- the first log row is when the organizer opened the tracker (play began), the
-- last completed one is when the final game landed. Byes are excluded — they
-- complete the instant they are created and have no play to time.
UPDATE "Match" m
SET "startedAt"   = s.first_log,
    "completedAt" = CASE WHEN m."status" = 'COMPLETED' THEN s.last_done ELSE NULL END
FROM (
  SELECT "matchId",
         MIN("createdAt")   AS first_log,
         MAX("completedAt") AS last_done
  FROM "MatchGameLog"
  GROUP BY "matchId"
) s
WHERE m."id" = s."matchId" AND m."isBye" = false;

-- Matches completed without ever opening the tracker (walkovers, forfeits,
-- results typed straight in) keep NULL rather than an invented time; the
-- analytics endpoint counts them as unmeasurable instead of as zero-length.

-- CreateIndex
CREATE INDEX "Match_completedAt_idx" ON "Match"("completedAt");
CREATE INDEX "Match_status_startedAt_idx" ON "Match"("status", "startedAt");
