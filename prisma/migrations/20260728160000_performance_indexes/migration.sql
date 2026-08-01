-- Postgres does not create indexes for foreign keys automatically. Match had none
-- at all despite being the most-read table in the application, so every bracket
-- render and every forfeit lookup was a sequential scan.
CREATE INDEX "Match_roundId_idx" ON "Match"("roundId");
CREATE INDEX "Match_player1Id_idx" ON "Match"("player1Id");
CREATE INDEX "Match_player2Id_idx" ON "Match"("player2Id");
CREATE INDEX "Match_winnerId_idx" ON "Match"("winnerId");

-- Tracker reads always filter by match, usually together with trackerActive.
CREATE INDEX "MatchGameLog_matchId_trackerActive_idx"
  ON "MatchGameLog"("matchId", "trackerActive");

-- The existing unique index on TournamentParticipant leads with userId, so it
-- cannot serve a tournamentId-only filter - which is how nearly every read of
-- this table is shaped.
CREATE INDEX "TournamentParticipant_tournamentId_idx"
  ON "TournamentParticipant"("tournamentId");

-- status drives the public tournament list; createdById drives ?manageable=true.
CREATE INDEX "Tournament_status_idx" ON "Tournament"("status");
CREATE INDEX "Tournament_createdById_idx" ON "Tournament"("createdById");
