-- DropForeignKey
ALTER TABLE "TournamentParticipant" DROP CONSTRAINT "TournamentParticipant_userId_fkey";

-- AlterTable
ALTER TABLE "Tournament" ADD COLUMN     "guestCleanupAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "isExpired" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "TournamentParticipant" ADD CONSTRAINT "TournamentParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
