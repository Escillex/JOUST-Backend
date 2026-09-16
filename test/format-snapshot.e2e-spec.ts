import { systemOf, formatNameOf } from '../src/Formats/format-config.helper';
import { TournamentFormatService } from '../src/tournament-format/tournament-format.service';

/**
 * Finishing the format snapshot (todo.md §4, 2026-09-16). The rules have been
 * copied onto a tournament at start since 2026-09-13; the bracket type and the
 * preset's name were not, so a started tournament still fell apart if its
 * preset went away — which is why deleting one was forbidden outright.
 */
describe('systemOf / formatNameOf', () => {
  it('prefers the tournament’s own snapshot over the live preset', () => {
    const t = { system: 'SWISS', formatName: 'Swiss, 5 rounds', format: { system: 'DOUBLE_ELIMINATION', name: 'Renamed since' } } as any;
    expect(systemOf(t)).toBe('SWISS');
    expect(formatNameOf(t)).toBe('Swiss, 5 rounds');
  });

  it('falls back to the preset before a tournament starts', () => {
    const t = { system: null, formatName: null, format: { system: 'ROUND_ROBIN', name: 'Round robin' } } as any;
    expect(systemOf(t)).toBe('ROUND_ROBIN');
    expect(formatNameOf(t)).toBe('Round robin');
  });

  it('survives a preset that has been deleted', () => {
    const t = { system: 'SINGLE_ELIMINATION', formatName: 'Cup', format: null } as any;
    expect(systemOf(t)).toBe('SINGLE_ELIMINATION');
    expect(formatNameOf(t)).toBe('Cup');
    // And says nothing rather than guessing when there is neither.
    expect(systemOf({ system: null, format: null } as any)).toBeUndefined();
    expect(formatNameOf({} as any)).toBeNull();
  });
});

describe('deleting a format preset', () => {
  const build = (notStarted: { id: string; name: string }[]) => {
    const prisma: any = {
      tournamentFormat: { findUnique: jest.fn(async () => ({ id: 'f1' })), delete: jest.fn(async () => ({})) },
      tournament: { findMany: jest.fn(async () => notStarted) },
    };
    return { svc: new TournamentFormatService(prisma), prisma };
  };

  it('is allowed once every tournament using it has started — they keep their own copy', async () => {
    const { svc, prisma } = build([]);
    await expect(svc.delete('f1')).resolves.toMatchObject({ message: expect.any(String) });
    expect(prisma.tournamentFormat.delete).toHaveBeenCalled();
    // Only UPCOMING and OPEN are asked about.
    expect(prisma.tournament.findMany.mock.calls[0][0].where.status.in).toEqual(['UPCOMING', 'OPEN']);
  });

  it('is refused while a tournament that has not started still reads it, and names them', async () => {
    const { svc, prisma } = build([{ id: 't1', name: 'Friday Night' }]);
    await expect(svc.delete('f1')).rejects.toMatchObject({
      response: { code: 'FORMAT_IN_USE', tournaments: [{ id: 't1', name: 'Friday Night' }] },
    });
    expect(prisma.tournamentFormat.delete).not.toHaveBeenCalled();
  });
});
