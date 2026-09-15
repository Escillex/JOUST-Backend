-- Prize pool: Float -> free text, plus an optional picture of the prize.
--
-- A Float could only express cash, so every physical prize — the common case at
-- this scale — had to be left blank. Existing values are preserved as text
-- rather than dropped: 250 becomes "$250", 12.5 becomes "$12.5".
--
-- NB: do NOT strip trailing zeros with trim(trailing '0'), which eats
-- significant ones (250 -> "25"). Compare against floor() instead: whole
-- numbers cast through bigint so they lose the ".0", and fractional values keep
-- their decimals.
ALTER TABLE "Tournament"
  ALTER COLUMN "prizePool" TYPE TEXT
  USING CASE
    WHEN "prizePool" IS NULL THEN NULL
    WHEN "prizePool" = floor("prizePool") THEN '$' || "prizePool"::bigint::text
    ELSE '$' || "prizePool"::text
  END;

ALTER TABLE "Tournament" ADD COLUMN "prizeImageUrl" TEXT;
