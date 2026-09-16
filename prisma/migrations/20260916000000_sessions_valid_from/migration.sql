-- Sign out everywhere (2026-09-16). Sessions last 7 days and nothing could end
-- one early: a stolen token stayed good for a week, and changing the password
-- did not turn it off. A token issued before this moment is refused.
ALTER TABLE "User" ADD COLUMN "sessionsValidFrom" TIMESTAMP(3);
