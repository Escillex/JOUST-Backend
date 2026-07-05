-- CreateTable
CREATE TABLE "UserGameStats" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gameName" TEXT NOT NULL,
    "tournamentsPlayed" INTEGER NOT NULL DEFAULT 0,
    "tournamentsWon" INTEGER NOT NULL DEFAULT 0,
    "gamesPlayed" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "draws" INTEGER NOT NULL DEFAULT 0,
    "winRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "globalPoints" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserGameStats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserGameStats_userId_gameName_key" ON "UserGameStats"("userId", "gameName");

-- AddForeignKey
ALTER TABLE "UserGameStats" ADD CONSTRAINT "UserGameStats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
