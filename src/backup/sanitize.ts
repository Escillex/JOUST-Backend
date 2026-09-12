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
`;

/**
 * Assertion used by the test and by the export itself: after scrubbing, no row
 * may hold an address outside the reserved domain.
 *
 * This exists because "we scrub emails" is a claim that rots — the day someone
 * adds a table with an address in it, this must fail loudly rather than let a
 * half-scrubbed export out the door.
 */
export const SANITIZE_VERIFY_SQL = `
SELECT count(*)::int AS leaked
FROM "User"
WHERE "email" IS NOT NULL AND "email" NOT LIKE '%@example.invalid';
`;
