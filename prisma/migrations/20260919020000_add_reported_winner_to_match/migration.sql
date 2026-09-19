-- Player-reported deciding results remain pending until staff verification.
ALTER TABLE "Match" ADD COLUMN "reportedWinnerId" TEXT;

ALTER TABLE "Match"
  ADD CONSTRAINT "Match_reportedWinnerId_fkey"
  FOREIGN KEY ("reportedWinnerId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Match_reportedWinnerId_idx" ON "Match"("reportedWinnerId");
