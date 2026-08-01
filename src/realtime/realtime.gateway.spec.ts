import { RealtimeGateway } from './realtime.gateway';
import { JwtService } from '@nestjs/jwt';

/** SOCKET SECURITY — regression tests for the private-room origin gate.
 *
 *  These exist because the failure they guard against is silent: if the gate
 *  regresses, nothing errors and nothing looks broken — a cross-origin page
 *  simply starts receiving someone else's notifications. */
describe('RealtimeGateway private room gate', () => {
  const USER_ID = 'user-123';

  /** A socket whose cookie carries a valid token, arriving from `origin`. */
  function makeClient(origin: string | undefined) {
    const joined: string[] = [];
    return {
      joined,
      client: {
        handshake: {
          headers: {
            cookie: 'token=valid-token',
            ...(origin === undefined ? {} : { origin }),
          },
        },
        data: {} as Record<string, unknown>,
        join: (room: string) => {
          joined.push(room);
        },
      },
    };
  }

  function makeGateway() {
    const jwt = {
      verify: () => ({ id: USER_ID }),
    } as unknown as JwtService;
    return new RealtimeGateway(jwt);
  }

  const ORIGINAL_ENV = { ...process.env };
  beforeEach(() => {
    // The app refuses to start without a real JWT_SECRET (7.7), so every test
    // here runs with one — asserting behaviour against a configuration that
    // could never actually boot would prove nothing.
    process.env.JWT_SECRET = 'K3f9wQ2mZp8vN1xR7tY4uB6cA0sD5gH2jL9kM3nP1qW8eR7t';
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('joins the private room for an allowlisted origin', () => {
    process.env.SOCKET_ALLOWED_ORIGINS = 'https://joust.escillex.com';
    const gateway = makeGateway();
    const { client, joined } = makeClient('https://joust.escillex.com');

    gateway.handleConnection(client as never);

    expect(joined).toContain(`user:${USER_ID}`);
  });

  it('refuses the private room for an untrusted origin, even with a valid token', () => {
    process.env.SOCKET_ALLOWED_ORIGINS = 'https://joust.escillex.com';
    const gateway = makeGateway();
    const { client, joined } = makeClient('https://evil.example');

    gateway.handleConnection(client as never);

    expect(joined).not.toContain(`user:${USER_ID}`);
    expect(joined).toHaveLength(0);
  });

  it('refuses the private room when no origin header is present', () => {
    process.env.SOCKET_ALLOWED_ORIGINS = 'https://joust.escillex.com';
    const gateway = makeGateway();
    const { client, joined } = makeClient(undefined);

    gateway.handleConnection(client as never);

    expect(joined).toHaveLength(0);
  });

  it('still attaches the identity so a refused socket is not treated as signed out', () => {
    process.env.SOCKET_ALLOWED_ORIGINS = 'https://joust.escillex.com';
    const gateway = makeGateway();
    const { client } = makeClient('https://evil.example');

    gateway.handleConnection(client as never);

    expect((client.data as { user?: { id: string } }).user?.id).toBe(USER_ID);
  });

  it('honours a multi-entry allowlist and ignores surrounding whitespace', () => {
    process.env.SOCKET_ALLOWED_ORIGINS =
      'https://joust.escillex.com , http://localhost:3000';
    const gateway = makeGateway();
    const { client, joined } = makeClient('http://localhost:3000');

    gateway.handleConnection(client as never);

    expect(joined).toContain(`user:${USER_ID}`);
  });

  it('falls back to the built-in defaults when the env var is unset', () => {
    delete process.env.SOCKET_ALLOWED_ORIGINS;
    const gateway = makeGateway();
    const { client, joined } = makeClient('http://localhost:3000');

    gateway.handleConnection(client as never);

    expect(joined).toContain(`user:${USER_ID}`);
  });

  it('does not join any room when the socket carries no token at all', () => {
    const gateway = makeGateway();
    const joined: string[] = [];
    const client = {
      handshake: { headers: { origin: 'http://localhost:3000' } },
      data: {},
      join: (room: string) => joined.push(room),
    };

    gateway.handleConnection(client as never);

    expect(joined).toHaveLength(0);
  });
});
