-- Drop dependent foreign keys first
ALTER TABLE "Tournament" DROP CONSTRAINT IF EXISTS "Tournament_createdById_fkey";
ALTER TABLE "TournamentParticipant" DROP CONSTRAINT IF EXISTS "TournamentParticipant_userId_fkey";
ALTER TABLE "Match" DROP CONSTRAINT IF EXISTS "Match_player1Id_fkey";
ALTER TABLE "Match" DROP CONSTRAINT IF EXISTS "Match_player2Id_fkey";
ALTER TABLE "Match" DROP CONSTRAINT IF EXISTS "Match_winnerId_fkey";

-- AlterTable Match
ALTER TABLE "Match" ADD COLUMN "loserNextMatchId" TEXT;

-- AlterTable Tournament
ALTER TABLE "Tournament" ADD COLUMN "winnerId" TEXT;

-- AlterTable User
ALTER TABLE "User" ADD COLUMN "guestName" TEXT,
ADD COLUMN "isGuest" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "email" DROP NOT NULL,
ALTER COLUMN "hashedPassword" DROP NOT NULL,
ALTER COLUMN "username" DROP NOT NULL,
ADD CONSTRAINT "User_pkey" PRIMARY KEY ("id");

-- DropIndex
DROP INDEX "User_id_key";

-- Re-add foreign keys
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_winnerId_fkey" FOREIGN KEY ("winnerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TournamentParticipant" ADD CONSTRAINT "TournamentParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Match" ADD CONSTRAINT "Match_player1Id_fkey" FOREIGN KEY ("player1Id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Match" ADD CONSTRAINT "Match_player2Id_fkey" FOREIGN KEY ("player2Id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Match" ADD CONSTRAINT "Match_winnerId_fkey" FOREIGN KEY ("winnerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Match" ADD CONSTRAINT "Match_loserNextMatchId_fkey" FOREIGN KEY ("loserNextMatchId") REFERENCES "Match"("id") ON DELETE SET NULL ON UPDATE CASCADE;