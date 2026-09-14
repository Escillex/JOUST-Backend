-- Forced first-password-change.
--
-- Defaults to false so every EXISTING account is untouched: those passwords were
-- either chosen by their owner or have been in use long enough that forcing a
-- change at next sign-in would be a surprise lockout, not a security win. Only
-- accounts created or reset by somebody else from here on get the flag.
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
