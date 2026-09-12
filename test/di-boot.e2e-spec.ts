import { Test } from '@nestjs/testing';
import { ScheduleModule } from '@nestjs/schedule';
// Imported first on purpose, mirroring app.module.ts: TournamentModule sits in a
// pre-existing require cycle (tournament -> formats -> tournament, with match in
// the middle), and whichever module enters that cycle first determines whether
// the inner references are already defined. Loading ParticipantModule first
// enters the cycle at the wrong point and leaves TournamentModule's MatchModule
// reference undefined - an artefact of the entry point, not of the app.
import { TournamentModule } from '../src/tournament/tournament.module';
import { ParticipantModule } from '../src/tournament/participant/participant.module';
import { ParticipantService } from '../src/tournament/participant/participant.service';
import { PrismaService } from 'prisma/prisma.service';
import { BackupModule } from '../src/backup/backup.module';
import { BackupService } from '../src/backup/backup.service';
import { SettingsAdminModule } from '../src/settings/settings-admin.module';
import { AwardModule } from '../src/award/award.module';
import { AwardService } from '../src/award/award.service';

// Temporary check: compiling ParticipantModule resolves it plus everything it
// now pulls in (MatchModule -> FormatsModule -> TournamentModule, RealtimeModule)
// without connecting to a database, which is the only way to catch a missing
// module import or an unresolvable constructor dependency short of booting the
// server. AppModule itself cannot be compiled here: ImagesModule imports `uuid`,
// which this jest config does not transform.
describe('DI graph', () => {
  it('ParticipantModule compiles with its new MatchService/RealtimeGateway deps', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TournamentModule, ParticipantModule],
    })
      .overrideProvider(PrismaService)
      .useValue({ $connect: jest.fn(), $disconnect: jest.fn() })
      .compile();

    expect(moduleRef.get(ParticipantService)).toBeDefined();
    await moduleRef.close();
  });

  // BackupModule's controller is guarded by JwtAuthGuard, which needs JwtService
  // from AuthModule. Missing that import compiled fine and type-checked fine,
  // and only failed when the container booted — exactly what this spec exists to
  // catch. SettingsAdminModule comes along because it now depends on BackupJob.
  it('BackupModule and SettingsAdminModule resolve their guards and deps', async () => {
    const moduleRef = await Test.createTestingModule({
      // ScheduleModule.forRoot() is `global: true`, so the running app gets
      // SchedulerRegistry for free; an isolated test module has to ask.
      imports: [ScheduleModule.forRoot(), BackupModule, SettingsAdminModule],
    })
      .overrideProvider(PrismaService)
      .useValue({ $connect: jest.fn(), $disconnect: jest.fn() })
      .compile();

    expect(moduleRef.get(BackupService)).toBeDefined();
    await moduleRef.close();
  });

  // Three guarded controllers plus ImagesService and NotificationService from
  // other modules — the shape most likely to be missing an import.
  it('AwardModule resolves its guards and cross-module services', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot(), AwardModule],
    })
      .overrideProvider(PrismaService)
      .useValue({ $connect: jest.fn(), $disconnect: jest.fn() })
      .compile();

    expect(moduleRef.get(AwardService)).toBeDefined();
    await moduleRef.close();
  });
});
