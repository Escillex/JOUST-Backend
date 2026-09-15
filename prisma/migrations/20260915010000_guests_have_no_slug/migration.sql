-- Guests are addressed by id, never by a profile handle.
--
-- A guest is a temporary row the cleanup job deletes after the tournament ends.
-- Giving one a slug took a readable name ("swift-falcon") out of a namespace
-- shared with real accounts and, because the unique index survives nothing, kept
-- it reserved against the next person who wants it. Guest rows created by the
-- replace path never had one anyway, so this also makes the data consistent with
-- itself. Nothing breaks: GET /users/:handle/profile resolves a UUID as well as
-- a slug, and profileHref() already falls back to the id when slug is null.
UPDATE "User" SET "slug" = NULL WHERE "isGuest" = true AND "slug" IS NOT NULL;
