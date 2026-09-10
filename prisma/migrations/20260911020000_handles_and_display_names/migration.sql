-- Split identity into a handle and a display name, and make both identifiers
-- case-insensitively unique.
--
-- Before this, `username` was doing two jobs badly: it was the login identifier
-- AND the human-readable name, so it contained spaces ("Mira Calder") that had
-- to be percent-encoded in URLs, and its uniqueness was case-sensitive — meaning
-- `casetest` and `CaseTest` could both exist while `CASETEST` could not log in
-- as either.

-- 1. Refuse to run if the data already contains case-collisions. A functional
--    unique index cannot be built over them, and silently picking a winner would
--    destroy an account.
DO $$
DECLARE dupes TEXT;
BEGIN
  SELECT string_agg(name, ', ') INTO dupes FROM (
    SELECT lower(username) AS name FROM "User"
    WHERE username IS NOT NULL GROUP BY 1 HAVING count(*) > 1
  ) d;
  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION 'Case-insensitive username collisions must be resolved first: %', dupes;
  END IF;

  SELECT string_agg(mail, ', ') INTO dupes FROM (
    SELECT lower(email) AS mail FROM "User"
    WHERE email IS NOT NULL GROUP BY 1 HAVING count(*) > 1
  ) d;
  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION 'Case-insensitive email collisions must be resolved first: %', dupes;
  END IF;
END $$;

-- 2. Add the display name.
ALTER TABLE "User" ADD COLUMN "displayName" TEXT;

-- 3. Move the old human-readable username into displayName, and adopt the slug
--    as the handle. The slug is already unique and already handle-shaped
--    (lowercase, hyphens), so it is the natural handle — no new derivation and
--    no chance of collision. "Mira Calder" -> @mira-calder, shown as "Mira Calder".
UPDATE "User"
SET "displayName" = "username",
    "username" = COALESCE("slug", lower(regexp_replace("username", '[^A-Za-z0-9._-]+', '-', 'g')))
WHERE "username" IS NOT NULL;

-- 4. Canonicalise emails to lowercase now that uniqueness ignores case.
UPDATE "User" SET "email" = lower("email") WHERE "email" IS NOT NULL;

-- 5. Case-insensitive uniqueness. Functional indexes rather than citext: no
--    extension required, and Prisma tolerates indexes it does not model.
CREATE UNIQUE INDEX "User_username_lower_key" ON "User" (lower("username"));
CREATE UNIQUE INDEX "User_email_lower_key" ON "User" (lower("email"));
