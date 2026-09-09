-- User profile handles (slug) + persisted tournament placement.
--
-- Adds User.slug (unique, URL-friendly handle for /profile/<slug>) and
-- TournamentParticipant.placement (final placing, 1 = champion). The slug column
-- is filled for existing users from their username before the unique index is
-- created, with a numeric suffix on collision so the constraint always holds.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "slug" TEXT;

-- AlterTable
ALTER TABLE "TournamentParticipant" ADD COLUMN "placement" INTEGER;

-- Backfill existing users' slugs from username. slugify(username) -> lowercase,
-- non-alphanumerics to '-', trimmed; empty falls back to 'player'. ROW_NUMBER
-- disambiguates same-base collisions ("swift-falcon", "swift-falcon-2", ...) so
-- the unique index below never fails on legacy data. Idempotent: only touches
-- rows whose slug is still NULL.
WITH base AS (
  SELECT
    "id",
    COALESCE(
      NULLIF(
        trim(BOTH '-' FROM regexp_replace(lower(COALESCE("username", 'player')), '[^a-z0-9]+', '-', 'g')),
        ''
      ),
      'player'
    ) AS b
  FROM "User"
  WHERE "slug" IS NULL
),
ranked AS (
  SELECT "id", b, ROW_NUMBER() OVER (PARTITION BY b ORDER BY "id") AS rn
  FROM base
)
UPDATE "User" u
SET "slug" = CASE WHEN r.rn = 1 THEN r.b ELSE r.b || '-' || r.rn END
FROM ranked r
WHERE u."id" = r."id";

-- CreateIndex
CREATE UNIQUE INDEX "User_slug_key" ON "User"("slug");
