import { Test, TestingModule } from '@nestjs/testing';
import { CleanGuestsJob } from './cleanGuests';
import { PrismaService } from 'prisma/prisma.service';

describe('CleanGuestsJob', () => {
  let job: CleanGuestsJob;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CleanGuestsJob,
        {
          provide: PrismaService,
          useValue: {
            user: {
              deleteMany: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    job = module.get<CleanGuestsJob>(CleanGuestsJob);
    prisma = module.get<PrismaService>(PrismaService);
  });

  it('Deletes guest users with no participant records', async () => {
    const deleteManySpy = jest.spyOn(prisma.user, 'deleteMany').mockResolvedValue({ count: 5 } as any);

    const result = await job.cleanOrphanedGuests();

    expect(result).toBe(5);
    expect(deleteManySpy).toHaveBeenCalledWith({
      where: {
        isGuest: true,
        participatedTournaments: {
          none: {},
        },
      },
    });
  });

  it('Running twice produces the same result (idempotency)', async () => {
    jest.spyOn(prisma.user, 'deleteMany')
      .mockResolvedValueOnce({ count: 5 } as any)
      .mockResolvedValueOnce({ count: 0 } as any);

    const result1 = await job.cleanOrphanedGuests();
    const result2 = await job.cleanOrphanedGuests();

    expect(result1).toBe(5);
    expect(result2).toBe(0);
  });
});
