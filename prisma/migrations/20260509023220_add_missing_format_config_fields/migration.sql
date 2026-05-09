-- AlterTable
ALTER TABLE "FormatConfig" ADD COLUMN     "allowDraw" BOOLEAN,
ADD COLUMN     "bestOf" INTEGER,
ADD COLUMN     "progressionType" TEXT,
ADD COLUMN     "tieBreakerOrder" TEXT[] DEFAULT ARRAY[]::TEXT[];
