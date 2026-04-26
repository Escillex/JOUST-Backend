/*
  Warnings:

  - A unique constraint covering the columns `[inviteToken]` on the table `Tournament` will be added. If there are existing duplicate values, this will fail.
  - The required column `inviteToken` was added to the `Tournament` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.

*/
-- AlterEnum
ALTER TYPE "TournamentFormat" ADD VALUE 'CUSTOM';

-- AlterTable
ALTER TABLE "FormatConfig" ADD COLUMN     "customRules" JSONB,
ADD COLUMN     "customTemplateId" TEXT,
ADD COLUMN     "progression" JSONB;

-- AlterTable
ALTER TABLE "Tournament" ADD COLUMN     "date" TIMESTAMP(3),
ADD COLUMN     "entranceFee" DOUBLE PRECISION,
ADD COLUMN     "inviteToken" TEXT NOT NULL,
ADD COLUMN     "venue" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Tournament_inviteToken_key" ON "Tournament"("inviteToken");
