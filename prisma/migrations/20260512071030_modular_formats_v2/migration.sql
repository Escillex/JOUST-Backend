/*
  Warnings:

  - You are about to drop the column `format` on the `Tournament` table. All the data in the column will be lost.
  - You are about to drop the `FormatConfig` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TournamentTemplate` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "TournamentSystem" AS ENUM ('SINGLE_ELIMINATION', 'DOUBLE_ELIMINATION', 'SWISS', 'ROUND_ROBIN', 'HYBRID');

-- DropForeignKey
ALTER TABLE "FormatConfig" DROP CONSTRAINT "FormatConfig_tournamentId_fkey";

-- DropForeignKey
ALTER TABLE "TournamentTemplate" DROP CONSTRAINT "TournamentTemplate_createdById_fkey";

-- DropForeignKey
ALTER TABLE "TournamentTemplate" DROP CONSTRAINT "TournamentTemplate_gameId_fkey";

-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "phase" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Tournament" DROP COLUMN "format",
ADD COLUMN     "formatId" TEXT;

-- DropTable
DROP TABLE "FormatConfig";

-- DropTable
DROP TABLE "TournamentTemplate";

-- DropEnum
DROP TYPE "TournamentFormat";

-- CreateTable
CREATE TABLE "TournamentFormat" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "system" "TournamentSystem" NOT NULL,
    "config" JSONB NOT NULL,
    "isBuiltin" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TournamentFormat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TournamentFormat_name_key" ON "TournamentFormat"("name");

-- AddForeignKey
ALTER TABLE "TournamentFormat" ADD CONSTRAINT "TournamentFormat_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_formatId_fkey" FOREIGN KEY ("formatId") REFERENCES "TournamentFormat"("id") ON DELETE SET NULL ON UPDATE CASCADE;
