-- DropForeignKey
ALTER TABLE "Tournament" DROP CONSTRAINT "Tournament_createdById_fkey";

-- AlterTable
ALTER TABLE "Tournament" ALTER COLUMN "createdById" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
