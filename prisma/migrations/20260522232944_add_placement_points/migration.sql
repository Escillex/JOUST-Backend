/*
  Warnings:

  - You are about to drop the column `gameId` on the `Tournament` table. All the data in the column will be lost.
  - You are about to drop the `Game` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "GameTrackingMode" AS ENUM ('HP', 'POINTS');

-- DropForeignKey
ALTER TABLE "Game" DROP CONSTRAINT "Game_createdById_fkey";

-- DropForeignKey
ALTER TABLE "Tournament" DROP CONSTRAINT "Tournament_gameId_fkey";

-- AlterTable
ALTER TABLE "Tournament" DROP COLUMN "gameId",
ADD COLUMN     "bannerUrl" TEXT;

-- AlterTable
ALTER TABLE "TournamentFormat" ADD COLUMN     "gameName" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "avatarUrl" TEXT;

-- DropTable
DROP TABLE "Game";

-- CreateTable
CREATE TABLE "TournamentParticipantStats" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "gamesPlayed" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "draws" INTEGER NOT NULL DEFAULT 0,
    "points" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "winRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "omw" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "oomw" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TournamentParticipantStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserGlobalStats" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tournamentsPlayed" INTEGER NOT NULL DEFAULT 0,
    "tournamentsWon" INTEGER NOT NULL DEFAULT 0,
    "gamesPlayed" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "draws" INTEGER NOT NULL DEFAULT 0,
    "winRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "globalPoints" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserGlobalStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchGameLog" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "gameNumber" INTEGER NOT NULL,
    "mode" "GameTrackingMode" NOT NULL,
    "startingValue" INTEGER NOT NULL,
    "player1Value" INTEGER NOT NULL DEFAULT 0,
    "player2Value" INTEGER NOT NULL DEFAULT 0,
    "trackerActive" BOOLEAN NOT NULL DEFAULT true,
    "winnerId" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchGameLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteAsset" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreProduct" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" TEXT NOT NULL,
    "imageUrl" TEXT,
    "category" TEXT,
    "description" TEXT,
    "link" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreProduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TournamentParticipantStats_participantId_key" ON "TournamentParticipantStats"("participantId");

-- CreateIndex
CREATE UNIQUE INDEX "UserGlobalStats_userId_key" ON "UserGlobalStats"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SiteAsset_key_key" ON "SiteAsset"("key");

-- AddForeignKey
ALTER TABLE "TournamentParticipantStats" ADD CONSTRAINT "TournamentParticipantStats_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "TournamentParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserGlobalStats" ADD CONSTRAINT "UserGlobalStats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchGameLog" ADD CONSTRAINT "MatchGameLog_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
