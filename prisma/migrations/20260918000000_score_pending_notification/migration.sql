-- The `SCORE_PENDING` notification type: a player self-scored a result that a
-- tournament's staff must review and verify. Sent to that tournament's
-- organizers (see NotificationService.notifyTournamentOrganizers).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SCORE_PENDING';