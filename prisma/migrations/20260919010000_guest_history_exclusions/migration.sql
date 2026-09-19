CREATE TABLE "GuestHistoryExclusion" (
  "id" TEXT NOT NULL,
  "guestId" TEXT NOT NULL,
  "tournamentId" TEXT NOT NULL,
  "excludedById" TEXT NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GuestHistoryExclusion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GuestHistoryExclusion_guestId_tournamentId_key"
  ON "GuestHistoryExclusion"("guestId", "tournamentId");
CREATE INDEX "GuestHistoryExclusion_guestId_idx" ON "GuestHistoryExclusion"("guestId");
ALTER TABLE "GuestHistoryExclusion" ADD CONSTRAINT "GuestHistoryExclusion_guestId_fkey"
  FOREIGN KEY ("guestId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GuestHistoryExclusion" ADD CONSTRAINT "GuestHistoryExclusion_tournamentId_fkey"
  FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GuestHistoryExclusion" ADD CONSTRAINT "GuestHistoryExclusion_excludedById_fkey"
  FOREIGN KEY ("excludedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
