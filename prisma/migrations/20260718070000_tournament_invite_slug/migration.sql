-- Short human-readable invite name for tournaments (e.g. "summer-cup").
-- Nullable: existing tournaments keep NULL and their long UUID invite
-- links keep working. Unique so one name can only point to one tournament.
ALTER TABLE "Tournament" ADD COLUMN "slug" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Tournament_slug_key" ON "Tournament"("slug");
