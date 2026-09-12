-- Google sign-in: the stable Google account id (`sub`), matched before email.
-- Nullable and unique — most accounts are never linked, and one Google account
-- can belong to at most one JOUST account.
ALTER TABLE "User" ADD COLUMN "googleId" TEXT;
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
