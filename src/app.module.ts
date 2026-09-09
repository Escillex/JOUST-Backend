import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from 'prisma/prisma.module';
import { TournamentModule } from './tournament/tournament.module';
import { ParticipantModule } from './tournament/participant/participant.module';
import { FormatsModule } from './Formats/formats.module';
import { LeaderboardModule } from './leaderboard/leaderboard.module';
import { JobsModule } from './jobs/jobs.module';
import { UserModule } from './user/user.module';
import { DevModule } from './dev/dev.module';
import { TournamentFormatModule } from './tournament-format/tournament-format.module';
import { GameModule } from './game/game.module';
import { ImagesModule } from './images/images.module';
import { StoreModule } from './store/store.module';
import { TrackerModule } from './tournament/match/tracker/tracker.module';
import { MatchUtilityModule } from './tournament/match/utility/utility.module';
import { RealtimeModule } from './realtime/realtime.module';
import { NotificationModule } from './notification/notification.module';
import { OrganizerModule } from './organizer/organizer.module';
import { SearchModule } from './search/search.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    AuthModule,
    PrismaModule,
    TournamentModule,
    ParticipantModule,
    FormatsModule,
    LeaderboardModule,
    JobsModule,
    UserModule,
    DevModule,
    TournamentFormatModule,
    GameModule,
    ImagesModule,
    StoreModule,
    TrackerModule,
    MatchUtilityModule,
    RealtimeModule,
    NotificationModule,
    OrganizerModule,
    SearchModule,
  ],
})
export class AppModule {}
