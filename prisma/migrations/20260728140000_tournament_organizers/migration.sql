-- Co-organizers: staff invited to co-manage a single tournament.
CREATE TYPE "OrganizerInviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

CREATE TABLE "TournamentOrganizer" (
  "id" TEXT NOT NULL,
  "tournamentId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" "OrganizerInviteStatus" NOT NULL DEFAULT 'PENDING',
  "invitedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "respondedAt" TIMESTAMP(3),
  CONSTRAINT "TournamentOrganizer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TournamentOrganizer_tournamentId_userId_key"
  ON "TournamentOrganizer"("tournamentId", "userId");
CREATE INDEX "TournamentOrganizer_userId_status_idx"
  ON "TournamentOrganizer"("userId", "status");

ALTER TABLE "TournamentOrganizer"
  ADD CONSTRAINT "TournamentOrganizer_tournamentId_fkey"
  FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TournamentOrganizer"
  ADD CONSTRAINT "TournamentOrganizer_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TournamentOrganizer"
  ADD CONSTRAINT "TournamentOrganizer_invitedById_fkey"
  FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
