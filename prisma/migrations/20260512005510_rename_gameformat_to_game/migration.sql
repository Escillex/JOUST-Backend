/*
  Warnings:

  - You are about to drop the column `gameFormatId` on the `Tournament` table. All the data in the column will be lost.
  - You are about to drop the column `gameFormatId` on the `TournamentTemplate` table. All the data in the column will be lost.
  - You are about to drop the `GameFormat` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "GameFormat" DROP CONSTRAINT "GameFormat_createdById_fkey";

-- DropForeignKey
ALTER TABLE "Tournament" DROP CONSTRAINT "Tournament_gameFormatId_fkey";

-- DropForeignKey
ALTER TABLE "TournamentTemplate" DROP CONSTRAINT "TournamentTemplate_gameFormatId_fkey";

-- AlterTable
ALTER TABLE "Tournament" DROP COLUMN "gameFormatId",
ADD COLUMN     "gameId" TEXT;

-- AlterTable
ALTER TABLE "TournamentTemplate" DROP COLUMN "gameFormatId",
ADD COLUMN     "gameId" TEXT;

-- DropTable
DROP TABLE "GameFormat";

-- CreateTable
CREATE TABLE "Game" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isBuiltin" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Game_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Game_name_key" ON "Game"("name");

-- AddForeignKey
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Game" ADD CONSTRAINT "Game_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentTemplate" ADD CONSTRAINT "TournamentTemplate_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE SET NULL ON UPDATE CASCADE;
