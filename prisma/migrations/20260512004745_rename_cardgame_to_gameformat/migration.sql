/*
  Warnings:

  - You are about to drop the column `cardGameId` on the `Tournament` table. All the data in the column will be lost.
  - You are about to drop the column `cardGameId` on the `TournamentTemplate` table. All the data in the column will be lost.
  - You are about to drop the `CardGame` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "CardGame" DROP CONSTRAINT "CardGame_createdById_fkey";

-- DropForeignKey
ALTER TABLE "Tournament" DROP CONSTRAINT "Tournament_cardGameId_fkey";

-- DropForeignKey
ALTER TABLE "TournamentTemplate" DROP CONSTRAINT "TournamentTemplate_cardGameId_fkey";

-- AlterTable
ALTER TABLE "Tournament" DROP COLUMN "cardGameId",
ADD COLUMN     "gameFormatId" TEXT;

-- AlterTable
ALTER TABLE "TournamentTemplate" DROP COLUMN "cardGameId",
ADD COLUMN     "gameFormatId" TEXT;

-- DropTable
DROP TABLE "CardGame";

-- CreateTable
CREATE TABLE "GameFormat" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isBuiltin" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameFormat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GameFormat_name_key" ON "GameFormat"("name");

-- AddForeignKey
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_gameFormatId_fkey" FOREIGN KEY ("gameFormatId") REFERENCES "GameFormat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameFormat" ADD CONSTRAINT "GameFormat_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentTemplate" ADD CONSTRAINT "TournamentTemplate_gameFormatId_fkey" FOREIGN KEY ("gameFormatId") REFERENCES "GameFormat"("id") ON DELETE SET NULL ON UPDATE CASCADE;
