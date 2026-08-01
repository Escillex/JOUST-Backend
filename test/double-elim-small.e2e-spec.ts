import { FormatsService } from '../src/Formats/formats.service';

// A two-player double-elimination bracket has k = log2(2) = 1, so the losers
// bracket loop runs `r <= 2k-2` = zero times and losersMatchIds stays empty.
// The winners->losers linking then read losersMatchIds[0][...] and threw, which
// made every 2-player double-elimination tournament fail to start with a 500.
describe('initDoubleElimination with a two-player bracket', () => {
  const build = () => {
    let matchSeq = 0;
    const updates: any[] = [];
    const prisma = {
      round: {
        create: jest.fn(async ({ data }: any) => ({
          id: `r${data.roundNumber}`,
          ...data,
        })),
      },
      match: {
        update: jest.fn(async (args: any) => {
          updates.push(args);
          return {};
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as any;
    const matchService = {
      createMatch: jest.fn(async () => ({
        id: `m${++matchSeq}`,
        player1Id: 'p1',
        player2Id: 'p2',
        isBye: false,
      })),
      activateMatch: jest.fn(),
      linkMatches: jest.fn(),
    } as any;

    const service = new FormatsService(
      prisma,
      matchService,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, prisma, matchService, updates };
  };

  it('generates without throwing', async () => {
    const { service } = build();
    await expect(
      (service as any).initDoubleElimination('t1', ['p1', 'p2'], false),
    ).resolves.not.toThrow();
  });

  it('sends the winners-final loser to the grand final, since there is no losers bracket', async () => {
    const { service, updates } = build();
    await (service as any).initDoubleElimination('t1', ['p1', 'p2'], false);

    const loserLinks = updates.filter((u) => u.data?.loserNextMatchId);
    expect(loserLinks).toHaveLength(1);
    // Grand final is the last match created.
    expect(loserLinks[0].data.loserNextMatchId).toBe('m2');
  });
});
