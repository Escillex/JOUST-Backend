/**
 * The scrub applied to a SANITIZED export.
 *
 * A backup of this database is a list of real addresses beside real names. On a
 * schedule, in a directory, downloadable over HTTP, and about to be carried to a
 * second machine for the defense — that is a scam list with extra steps. A
 * sanitized export is the copy that may leave the building.
 *
 * Kept as SQL in a .ts file on purpose: a `.sql` file would need a build-assets
 * rule to survive `nest build`, and silently missing at runtime is exactly the
 * failure mode that would let an unscrubbed export out.
 *
 * What is KEPT is deliberate: usernames, display names, tournaments, matches and
 * standings are the substance of what a panel is being shown, and none of them
 * are contact details.
 */

/** Everyone in a sanitized copy shares this password. It is bcrypt("demo1234")
 *  — printed in the UI when such an export is made, so the demo is usable. */
export const SANITIZED_PASSWORD_PLAINTEXT = 'demo1234';
export const SANITIZED_PASSWORD_HASH =
  '$2b$10$nQ/7G1jGrzMgdjkYcO82rucqYuPRZao5IUACtlZpNXwtWpMslykoC';

/**
 * Runs inside a scratch database holding a freshly restored copy — never
 * against the live one.
 *
 * `example.invalid` is reserved by RFC 2606 and can never resolve, so a
 * sanitized address cannot be mailed even by accident.
 */
export const SANITIZE_SQL = `
-- Addresses: derived from the row's own id, so they are unique by construction.
-- That matters: "User" carries a unique index on lower(email), and a hash prefix
-- could in principle collide and abort the whole scrub.
UPDATE "User"
SET "email" = 'user-' || replace("id", '-', '') || '@example.invalid'
WHERE "email" IS NOT NULL;

-- One shared, known password; nobody's real hash travels. The column is
-- "hashedPassword", not "password" — Prisma's field name and the column name
-- differ here, and raw SQL sees the column.
UPDATE "User" SET "hashedPassword" = '${SANITIZED_PASSWORD_HASH}'
WHERE "hashedPassword" IS NOT NULL;

-- Recovery codes are credentials too.
UPDATE "User" SET "twoFactorRecoveryCodes" = '{}';

-- Live authentication state has no business in a demo copy.
TRUNCATE TABLE "TwoFactorCode";
TRUNCATE TABLE "TrustedDevice";
TRUNCATE TABLE "EmailVerificationToken";

-- The SMTP key, and anything else stored encrypted.
DELETE FROM "SystemSetting" WHERE "encrypted" = true;

-- Everything environment-specific, which is also where the remaining real
-- addresses live. Deleting only the encrypted rows left "mail.host",
-- "mail.user" and "mail.from" in clear in a file that is deliberately
-- UNENCRYPTED because it is the copy meant to leave the building (found
-- 2026-09-16; see todo.md §6). These settings belong to whichever server is
-- running, never to the snapshot, so a target keeps its own either way.
-- GOOGLE_CLIENT_ID is public by design and would be kept if it were not
-- environment-specific.
DELETE FROM "SystemSetting"
WHERE "key" LIKE 'mail.%'
   OR "key" LIKE 'backup.%'
   OR "key" LIKE 'security.google%'
   OR "key" = 'setup.completedAt';

-- Uploaded pictures. The bundle carries the database and NOT the files under
-- the repo-root images/ directory, so every one of these paths would dangle on
-- the target. Dropping the references is therefore the privacy fix and the
-- broken-media fix at once, and the UI already degrades correctly: a lettered
-- avatar, the hatched banner ground, a lettered game icon.
UPDATE "User" SET "avatarUrl" = NULL WHERE "avatarUrl" IS NOT NULL;
UPDATE "Game" SET "iconUrl" = NULL WHERE "iconUrl" IS NOT NULL;
UPDATE "Tournament" SET "bannerUrl" = NULL WHERE "bannerUrl" IS NOT NULL;
UPDATE "Tournament" SET "prizeImageUrl" = NULL WHERE "prizeImageUrl" IS NOT NULL;
UPDATE "TournamentBuild" SET "imageUrl" = NULL WHERE "imageUrl" IS NOT NULL;
UPDATE "StoreProduct" SET "imageUrl" = NULL WHERE "imageUrl" IS NOT NULL;

-- Gallery photographs are pictures of real people's things, and the rows are
-- worthless without the files. Reports go first: they reference these rows, and
-- an explicit DELETE avoids TRUNCATE ... CASCADE reaching further than intended.
DELETE FROM "ContentReport";
DELETE FROM "GalleryImage";

-- The audit log is a record of who did what, which has no place on a demo box —
-- and it is a LEAK: the interceptor stores whitelisted setting values, so a
-- change to mail.from put a real address in here. Verified 2026-09-16 by
-- restoring a sanitized export and grepping it, which found exactly that after
-- the settings rows themselves were already being deleted.
DELETE FROM "AuditLog";

-- Site assets are rows of nothing but a path to a file the bundle does not
-- carry, so they are dead weight on the target either way.
DELETE FROM "SiteAsset";

-- KNOWN AND DELIBERATE, verified by the same grep: two sources of
-- "/uploads/..." survive, neither personal.
--   * "Award"."imageUrl" — site artwork, and the column is NOT NULL, so it
--     cannot be blanked without inventing a value. Blanking it would leave a
--     demo's medals empty.
--   * "HomeBlock"."content" — hero slide paths inside a JSON document; picking
--     them out in SQL risks corrupting the document, and the Hero component
--     already falls back to its bundled constants when a slide will not load.
-- Both 404 without the files, which is cosmetic, so they are excluded from the
-- guard below rather than quietly failing it.
`;

/**
 * Assertion used by the test and by the export itself: after scrubbing, nothing
 * the scrub claims to remove may remain — addresses outside the reserved
 * domain, environment-specific settings, or any uploaded-image reference.
 *
 * Returns ONE number on purpose: the caller reads the first integer out of
 * psql's output, so every category is summed into a single `leaked` scalar.
 *
 * This exists because "we scrub emails" is a claim that rots — the day someone
 * adds a table with an address in it, this must fail loudly rather than let a
 * half-scrubbed export out the door.
 */
export const SANITIZE_VERIFY_SQL = `
SELECT (
    (SELECT count(*) FROM "User"
      WHERE "email" IS NOT NULL AND "email" NOT LIKE '%@example.invalid')
  + (SELECT count(*) FROM "SystemSetting"
      WHERE "key" LIKE 'mail.%' OR "key" LIKE 'backup.%'
         OR "key" LIKE 'security.google%' OR "key" = 'setup.completedAt')
  + (SELECT count(*) FROM "User" WHERE "avatarUrl" IS NOT NULL)
  + (SELECT count(*) FROM "Game" WHERE "iconUrl" IS NOT NULL)
  + (SELECT count(*) FROM "Tournament"
      WHERE "bannerUrl" IS NOT NULL OR "prizeImageUrl" IS NOT NULL)
  + (SELECT count(*) FROM "TournamentBuild" WHERE "imageUrl" IS NOT NULL)
  + (SELECT count(*) FROM "StoreProduct" WHERE "imageUrl" IS NOT NULL)
  + (SELECT count(*) FROM "GalleryImage")
  + (SELECT count(*) FROM "AuditLog")
  + (SELECT count(*) FROM "SiteAsset")
)::int AS leaked;
`;
