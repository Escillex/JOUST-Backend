import { Test } from '@nestjs/testing';
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
});
