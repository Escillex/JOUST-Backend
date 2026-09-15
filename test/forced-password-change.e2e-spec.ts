import { JwtService } from '@nestjs/jwt';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from '../src/auth/auth.service';

/**
 * A password somebody else chose must buy exactly one thing: the chance to
 * replace it.
 *
 * The rules pinned here are the ones that make that true rather than decorative
 * — the sign-in must hand back no session, the token it hands back instead must
 * be useless anywhere else (`token-purpose.e2e-spec.ts` covers the guard side),
 * and setting the password back to the value you were given must be refused, or
 * the whole exercise is theatre.
 */
describe('forced password change', () => {
  const secret = 'test-secret-that-is-definitely-long-enough-32';
  const jwt = new JwtService({ secret });

  beforeAll(() => {
    process.env.JWT_SECRET = secret;
  });

  const build = (user: Record<string, unknown>) => {
    const prisma: any = {
      user: {
        // `findFirst` is used for two different questions: "who is signing in?"
        // and "is this address already taken by someone else?". The second
        // carries `id: { not }` and must answer nobody, or every address looks
        // taken by the very account trying to set it.
        findFirst: jest.fn().mockImplementation((args: any) =>
          Promise.resolve(args?.where?.id?.not ? null : user),
        ),
        findUnique: jest.fn().mockResolvedValue(user),
        update: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({ ...user, ...data }),
        ),
      },
    };
    const twoFactor: any = {
      emailRequired: jest.fn().mockResolvedValue(false),
      isRequiredFor: jest.fn().mockResolvedValue(false),
      isTrustedDevice: jest.fn().mockResolvedValue(false),
    };
    const res: any = { cookie: jest.fn() };
    return { prisma, res, service: new AuthService(prisma, jwt, twoFactor) };
  };

  const flagged = async (overrides: Record<string, unknown> = {}) => ({
    id: 'u1',
    email: 'temp@hobbyplus.test',
    username: 'tempuser',
    avatarUrl: null,
    roles: ['PLAYER'],
    isGuest: false,
    emailVerified: true,
    googleId: null,
    hashedPassword: await bcrypt.hash('GivenToMe123!', 10),
    mustChangePassword: true,
    ...overrides,
  });

  it('hands back a change token instead of a session, and sets no cookie', async () => {
    const { service, res } = build(await flagged());
    const result: any = await service.SignIn(
      { identifier: 'tempuser', password: 'GivenToMe123!' },
      res,
    );

    expect(result.passwordChangeRequired).toBe(true);
    expect(result.changeToken).toEqual(expect.any(String));
    expect(result.token).toBeUndefined();
    // The cookie is the session. Setting it here would hand over everything the
    // flag exists to withhold.
    expect(res.cookie).not.toHaveBeenCalled();
    expect(jwt.verify(result.changeToken).purpose).toBe('password_change');
  });

  it('refuses setting the password back to the one that was given', async () => {
    const user = await flagged();
    const { service, res } = build(user);
    const { changeToken }: any = await service.SignIn(
      { identifier: 'tempuser', password: 'GivenToMe123!' },
      res,
    );

    await expect(
      service.changeForcedPassword(changeToken, 'GivenToMe123!', res),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('clears the flag and issues a real session on a genuine replacement', async () => {
    const user = await flagged();
    const { service, res, prisma } = build(user);
    const { changeToken }: any = await service.SignIn(
      { identifier: 'tempuser', password: 'GivenToMe123!' },
      res,
    );

    const result: any = await service.changeForcedPassword(
      changeToken,
      'ChosenByMe456!',
      res,
    );

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ mustChangePassword: false }),
      }),
    );
    const stored = prisma.user.update.mock.calls[0][0].data.hashedPassword;
    expect(await bcrypt.compare('ChosenByMe456!', stored)).toBe(true);
    expect(result.token).toEqual(expect.any(String));
    expect(jwt.verify(result.token).purpose).toBe('session');
    expect(res.cookie).toHaveBeenCalled();
  });

  it('demands a working address when the account cannot receive mail', async () => {
    // The seeded admin is born with `admin@joust.local`. Letting it through here
    // is what strands the only ADMIN account the moment two-factor is switched
    // on — its codes go nowhere and a seeded account has no recovery codes.
    const { service, res } = build(await flagged({ email: 'admin@joust.local' }));
    const { changeToken }: any = await service.SignIn(
      { identifier: 'tempuser', password: 'GivenToMe123!' },
      res,
    );

    await expect(
      service.changeForcedPassword(changeToken, 'ChosenByMe456!', res),
    ).rejects.toMatchObject({ response: { code: 'EMAIL_REQUIRED' } });

    const ok: any = await service.changeForcedPassword(
      changeToken,
      'ChosenByMe456!',
      res,
      'real.admin@hobbyplus.test',
    );
    expect(ok.token).toEqual(expect.any(String));
  });

  it('refuses a 2FA challenge token in place of a change token', async () => {
    const { service, res } = build(await flagged());
    // Both are short-lived intermediates minted by the same signer; only the
    // purpose separates them, so the wrong one must not be interchangeable.
    const challenge = jwt.sign({ id: 'u1', purpose: '2fa', step: 'signin' });

    await expect(
      service.changeForcedPassword(challenge, 'ChosenByMe456!', res),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('leaves an ordinary account alone', async () => {
    const { service, res } = build(await flagged({ mustChangePassword: false }));
    const result: any = await service.SignIn(
      { identifier: 'tempuser', password: 'GivenToMe123!' },
      res,
    );

    expect(result.passwordChangeRequired).toBeUndefined();
    expect(result.token).toEqual(expect.any(String));
    expect(res.cookie).toHaveBeenCalled();
  });
});
