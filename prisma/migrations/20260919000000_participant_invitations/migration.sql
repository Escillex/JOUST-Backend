-- CreateEnum
CREATE TYPE "ParticipantInviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

ALTER TYPE "NotificationType" ADD VALUE 'PARTICIPANT_INVITED';

-- CreateTable
CREATE TABLE "TournamentParticipantInvite" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "invitedById" TEXT,
    "status" "ParticipantInviteStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "TournamentParticipantInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TournamentParticipantInvite_tournamentId_userId_key" ON "TournamentParticipantInvite"("tournamentId", "userId");

-- CreateIndex
CREATE INDEX "TournamentParticipantInvite_userId_status_idx" ON "TournamentParticipantInvite"("userId", "status");

-- AddForeignKey
ALTER TABLE "TournamentParticipantInvite" ADD CONSTRAINT "TournamentParticipantInvite_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentParticipantInvite" ADD CONSTRAINT "TournamentParticipantInvite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentParticipantInvite" ADD CONSTRAINT "TournamentParticipantInvite_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
