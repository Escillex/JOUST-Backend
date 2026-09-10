-- Distinguish a code that was entered correctly from one that was burned by
-- failed attempts or superseded by a resend. Both stamp `consumedAt`, but only
-- the first should exempt the user from the 60s resend throttle — without this,
-- signing out and back in within a minute produced a challenge with no pending
-- code and a resend that was itself throttled.
ALTER TABLE "TwoFactorCode" ADD COLUMN "succeededAt" TIMESTAMP(3);
