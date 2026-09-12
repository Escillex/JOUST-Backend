import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AuthService, normalizeBio } from '../src/auth/auth.service';
import { BIO_MAX_LENGTH, UpdateProfileDto } from '../src/auth/dto/auth.dto';

/** The profile bio (todo.md obj. 4.2): plain text, bounded, clearable. */
describe('bio', () => {
  it('refuses more than the limit at the API boundary', async () => {
    const tooLong = plainToInstance(UpdateProfileDto, { bio: 'x'.repeat(BIO_MAX_LENGTH + 1) });
    const ok = plainToInstance(UpdateProfileDto, { bio: 'x'.repeat(BIO_MAX_LENGTH) });
    expect((await validate(tooLong)).map((e) => e.property)).toContain('bio');
    expect(await validate(ok)).toHaveLength(0);
  });

  it('trims, keeps paragraphs, collapses runs of blank lines, and treats empty as no bio', () => {
    expect(normalizeBio('  Hello  ')).toBe('Hello');
    expect(normalizeBio('Line one\r\n\r\n\r\n\r\nLine two')).toBe('Line one\n\nLine two');
    expect(normalizeBio('   \n  ')).toBeNull();
  });

  it('is saved by a user editing their own profile — and so is displayName, which used to be dropped', async () => {
    const prisma: any = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'u1', username: 'paul' }),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(async ({ data }: any) => ({ id: 'u1', ...data })),
      },
    };
    const svc = new AuthService(prisma, {} as any, {} as any);
    await svc.updateMe('u1', { bio: '  Plays Swiss.  ', displayName: 'Paul Scholes' } as UpdateProfileDto);
    expect(prisma.user.update.mock.calls[0][0].data).toEqual({ bio: 'Plays Swiss.', displayName: 'Paul Scholes' });

    await svc.updateMe('u1', { bio: '' } as UpdateProfileDto);
    expect(prisma.user.update.mock.calls[1][0].data).toEqual({ bio: null });
  });
});
