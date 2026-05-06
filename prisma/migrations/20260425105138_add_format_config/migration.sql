-- CreateTable
CREATE TABLE "FormatConfig" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "winsToAdvance" INTEGER DEFAULT 1,
    "swissRounds" INTEGER,
    "swissPointsForWin" INTEGER DEFAULT 3,
    "swissPointsForDraw" INTEGER DEFAULT 1,
    "swissPointsForLoss" INTEGER DEFAULT 0,
    "pointsThreshold" INTEGER,
    "sessionsCount" INTEGER,
    "pointsPerSession" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FormatConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FormatConfig_tournamentId_key" ON "FormatConfig"("tournamentId");

-- AddForeignKey
ALTER TABLE "FormatConfig" ADD CONSTRAINT "FormatConfig_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;
