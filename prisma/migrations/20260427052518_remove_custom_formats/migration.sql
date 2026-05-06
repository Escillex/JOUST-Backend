/*
  Warnings:

  - The values [FREE_FOR_ALL,CUSTOM] on the enum `TournamentFormat` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `customRules` on the `FormatConfig` table. All the data in the column will be lost.
  - You are about to drop the column `customTemplateId` on the `FormatConfig` table. All the data in the column will be lost.
  - You are about to drop the column `progression` on the `FormatConfig` table. All the data in the column will be lost.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "TournamentFormat_new" AS ENUM ('SINGLE_ELIMINATION', 'DOUBLE_ELIMINATION', 'SWISS', 'ROUND_ROBIN');
ALTER TABLE "public"."Tournament" ALTER COLUMN "format" DROP DEFAULT;
ALTER TABLE "Tournament" ALTER COLUMN "format" TYPE "TournamentFormat_new" USING ("format"::text::"TournamentFormat_new");
ALTER TYPE "TournamentFormat" RENAME TO "TournamentFormat_old";
ALTER TYPE "TournamentFormat_new" RENAME TO "TournamentFormat";
DROP TYPE "public"."TournamentFormat_old";
ALTER TABLE "Tournament" ALTER COLUMN "format" SET DEFAULT 'SINGLE_ELIMINATION';
COMMIT;

-- AlterTable
ALTER TABLE "FormatConfig" DROP COLUMN "customRules",
DROP COLUMN "customTemplateId",
DROP COLUMN "progression";
