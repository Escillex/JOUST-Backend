-- AlterEnum
ALTER TYPE "TournamentStatus" ADD VALUE 'PENDING';

-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "p1Name" TEXT,
ADD COLUMN     "p2Name" TEXT,
ADD COLUMN     "winnerName" TEXT;
