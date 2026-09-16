-- Finish the format snapshot (todo.md §4). `config` has been copied onto a
-- tournament at start since 20260913040000, but the bracket type and the
-- preset's name were not — so a started tournament still depended on its
-- preset, and deleting the preset (or cascading it away with the account that
-- created it) left the tournament with no system.
ALTER TABLE "Tournament" ADD COLUMN "system" "TournamentSystem";
ALTER TABLE "Tournament" ADD COLUMN "formatName" TEXT;

-- Backfill everything that has already started, exactly as the config backfill
-- did. Tournaments still OPEN or UPCOMING are left null on purpose: they read
-- the live preset until the moment they start.
UPDATE "Tournament" t
SET "system" = f."system",
    "formatName" = f."name"
FROM "TournamentFormat" f
WHERE t."formatId" = f."id"
  AND t."status" IN ('ONGOING', 'COMPLETED');

-- A preset outlives the person who created it. It used to cascade: deleting an
-- organizer deleted their presets, and any tournament using one lost its
-- bracket type. With the snapshot above, a started tournament needs nothing
-- from the preset, and one that has not started still needs the preset to
-- exist — so the row is kept and simply loses its owner.
ALTER TABLE "TournamentFormat" DROP CONSTRAINT "TournamentFormat_createdById_fkey";
ALTER TABLE "TournamentFormat" ALTER COLUMN "createdById" DROP NOT NULL;
ALTER TABLE "TournamentFormat" ADD CONSTRAINT "TournamentFormat_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
