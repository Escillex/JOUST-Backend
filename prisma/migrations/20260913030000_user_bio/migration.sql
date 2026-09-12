-- A short public "about" line on the profile (todo.md obj. 4.2). Plain text;
-- the 300-character limit is enforced by UpdateProfileDto.
ALTER TABLE "User" ADD COLUMN "bio" TEXT;
