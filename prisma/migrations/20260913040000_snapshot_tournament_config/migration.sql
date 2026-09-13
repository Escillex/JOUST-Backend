-- Config snapshotting (todo.md §4). From now on a tournament copies its format
-- preset's rules onto itself at the moment it starts (startTournament), so
-- editing or deleting a shared preset can no longer change an event mid-flight.
--
-- Backfill the tournaments that started before this existed. ONGOING ones are
-- the point: they are currently exposed. COMPLETED ones get the preset's rules
-- as they stand TODAY — the preset may have been edited since those events ran,
-- so for them this is the best record available rather than a guaranteed one.
-- OPEN/UPCOMING tournaments are left alone: they snapshot when they start, and
-- an organizer may still be choosing a preset.
UPDATE "Tournament" AS t
SET "config" = f."config"
FROM "TournamentFormat" AS f
WHERE t."formatId" = f."id"
  AND t."config" IS NULL
  AND f."config" IS NOT NULL
  AND t."status" IN ('ONGOING', 'COMPLETED');
