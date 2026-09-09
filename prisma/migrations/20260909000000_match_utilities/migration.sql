-- Shared match utilities: per-match state (timer + coin/dice) + a notification
-- type for the timer-finish ping. See docs/shared-utilities-plan.md.

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'MATCH_TIMER_ENDED';

-- CreateTable
CREATE TABLE "MatchUtilityState" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "timerDurationSec" INTEGER,
    "timerEndsAt" TIMESTAMP(3),
    "timerRunning" BOOLEAN NOT NULL DEFAULT false,
    "timerPausedRemainingSec" INTEGER,
    "timerNotified" BOOLEAN NOT NULL DEFAULT false,
    "flips" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchUtilityState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MatchUtilityState_matchId_key" ON "MatchUtilityState"("matchId");

-- CreateIndex
CREATE INDEX "MatchUtilityState_timerRunning_idx" ON "MatchUtilityState"("timerRunning");

-- AddForeignKey
ALTER TABLE "MatchUtilityState" ADD CONSTRAINT "MatchUtilityState_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
