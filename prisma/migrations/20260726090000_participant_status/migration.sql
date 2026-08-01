-- Organizer participant management: mark a participant out of a live tournament.
-- Existing rows default to ACTIVE so nothing changes for in-flight tournaments.
CREATE TYPE "ParticipantStatus" AS ENUM ('ACTIVE', 'FORFEITED');

ALTER TABLE "TournamentParticipant"
  ADD COLUMN "status" "ParticipantStatus" NOT NULL DEFAULT 'ACTIVE';
