-- CreateEnum
CREATE TYPE "GameRequestStatus" AS ENUM ('PENDING', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "GameRequest" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "status" "GameRequestStatus" NOT NULL DEFAULT 'PENDING',
    "tournamentId" TEXT,
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GameRequest_status_idx" ON "GameRequest"("status");

-- AddForeignKey
ALTER TABLE "GameRequest" ADD CONSTRAINT "GameRequest_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameRequest" ADD CONSTRAINT "GameRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
