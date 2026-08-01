-- In-app inbox. Rows cascade with the user, so guest cleanup needs no special case.
CREATE TYPE "NotificationType" AS ENUM (
  'MATCH_READY',
  'MATCH_RESULT',
  'TOURNAMENT_OPENED',
  'TOURNAMENT_STARTED',
  'TOURNAMENT_PLACEMENT',
  'PARTICIPANT_ADDED',
  'PARTICIPANT_REMOVED',
  'PARTICIPANT_FORFEITED',
  'ORGANIZER_INVITED',
  'GUEST_CLEANUP_SCHEDULED'
);

CREATE TABLE "Notification" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "NotificationType" NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT,
  "link" TEXT,
  "tournamentId" TEXT,
  "read" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Notification_userId_read_idx" ON "Notification"("userId", "read");
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
