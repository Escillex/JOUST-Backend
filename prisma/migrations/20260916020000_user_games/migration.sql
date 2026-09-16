-- The games a user says they play (self-declared interest, not earned history).
-- Explicit join, matching UserGameStats / GalleryImage; the schema carries no
-- implicit many-to-many. Both sides cascade: losing the account or the game
-- should take the declaration with it, never leave an orphan row.
CREATE TABLE "UserGame" (
    "userId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserGame_pkey" PRIMARY KEY ("userId","gameId")
);

CREATE INDEX "UserGame_gameId_idx" ON "UserGame"("gameId");

ALTER TABLE "UserGame" ADD CONSTRAINT "UserGame_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserGame" ADD CONSTRAINT "UserGame_gameId_fkey"
    FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;
