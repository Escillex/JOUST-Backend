-- Data backfill for first-class Games (todo.md §5).
--
-- Promotes the legacy free-text `gameName` (on TournamentFormat and UserGameStats)
-- into real Game rows and links every Tournament to a game — the built-in
-- "General" being the floor for anything with no designation. All statements are
-- idempotent (guarded by NOT EXISTS / IS NULL), so re-running is harmless and a
-- fresh database with no legacy data simply ends up with just "General".

-- 1. Ensure the built-in "General" game exists. Self-sufficient: does not depend
--    on the seed having run. gen_random_uuid() is core in Postgres 13+.
INSERT INTO "Game" ("id", "name", "slug", "description", "isBuiltin", "updatedAt")
SELECT gen_random_uuid()::text, 'General', 'general',
       'Uncategorised play. The default game every tournament falls back to when no specific game is set.',
       true, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "Game" WHERE "name" = 'General');

-- 2. Promote each distinct legacy TournamentFormat.gameName into a Game.
INSERT INTO "Game" ("id", "name", "isBuiltin", "updatedAt")
SELECT gen_random_uuid()::text, d."gameName", false, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "gameName" FROM "TournamentFormat" WHERE "gameName" IS NOT NULL) d
WHERE NOT EXISTS (SELECT 1 FROM "Game" g WHERE g."name" = d."gameName");

-- 3. Link formats to their game.
UPDATE "TournamentFormat" tf
SET "gameId" = g."id"
FROM "Game" g
WHERE tf."gameName" IS NOT NULL AND g."name" = tf."gameName" AND tf."gameId" IS NULL;

-- 4. Link every tournament: its format's game if any, else "General".
UPDATE "Tournament" t
SET "gameId" = COALESCE(
  (SELECT tf."gameId" FROM "TournamentFormat" tf WHERE tf."id" = t."formatId"),
  (SELECT "id" FROM "Game" WHERE "name" = 'General')
)
WHERE t."gameId" IS NULL;

-- 5. Promote any UserGameStats.gameName not yet a Game, then link the FK. The
--    unique key stays [userId, gameName] for now; the [userId, gameId] switch is
--    a later migration once every row is linked.
INSERT INTO "Game" ("id", "name", "isBuiltin", "updatedAt")
SELECT gen_random_uuid()::text, d."gameName", false, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "gameName" FROM "UserGameStats" WHERE "gameName" IS NOT NULL) d
WHERE NOT EXISTS (SELECT 1 FROM "Game" g WHERE g."name" = d."gameName");

UPDATE "UserGameStats" s
SET "gameId" = g."id"
FROM "Game" g
WHERE g."name" = s."gameName" AND s."gameId" IS NULL;