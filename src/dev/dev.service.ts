import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ParticipantService } from '../tournament/participant/participant.service';
import { TournamentService } from '../tournament/tournament.service';

@Injectable()
export class DevService {
  constructor(
    private prisma: PrismaService,
    private participantService: ParticipantService,
  ) {}

  async batchAddGuests(tournamentId: string, count: number) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');

    const results: any[] = [];
    for (let i = 1; i <= count; i++) {
      const name = `Guest_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
      const res = await this.participantService.joinTournamentAsGuest(tournamentId, name);
      results.push(res);
    }
    return { message: `Added ${count} guests to tournament`, results };
  }

  async setGuestExpiry(days: number) {
    TournamentService.GUEST_EXPIRY_DAYS = days;
    return { message: `Guest expiration period updated to ${days} days.`, current: TournamentService.GUEST_EXPIRY_DAYS };
  }

  async deleteTournament(tournamentId: string) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
    });
    if (!tournament) throw new NotFoundException('Tournament not found');

    // Delete rounds and matches (Prisma will handle some via Cascade if set, but let's be safe)
    // Actually, in schema.prisma, Match/Round don't have Cascade from Tournament.
    
    const rounds = await this.prisma.round.findMany({ where: { tournamentId } });
    for (const round of rounds) {
       await this.prisma.match.deleteMany({ where: { roundId: round.id } });
    }
    await this.prisma.round.deleteMany({ where: { tournamentId } });
    await this.prisma.tournamentParticipant.deleteMany({ where: { tournamentId } });

    
    await this.prisma.tournament.delete({ where: { id: tournamentId } });

    return { message: `Tournament "${tournament.name}" and all related data deleted.` };
  }
}
