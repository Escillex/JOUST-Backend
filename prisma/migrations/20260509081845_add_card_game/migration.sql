-- AlterTable
ALTER TABLE "Tournament" ADD COLUMN     "cardGameId" TEXT;

-- CreateTable
CREATE TABLE "CardGame" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isBuiltin" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardGame_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CardGame_name_key" ON "CardGame"("name");

-- AddForeignKey
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_cardGameId_fkey" FOREIGN KEY ("cardGameId") REFERENCES "CardGame"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardGame" ADD CONSTRAINT "CardGame_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
