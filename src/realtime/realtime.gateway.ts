import { requireJwtSecret } from '../config/security.config';
import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';

/** The values broadcast for a live game tracker so listeners can move the
 *  HP/points bars without asking the server for the whole log list again. */
export interface TrackerUpdatePayload {
  matchId: string;
  player1Value: number;
  player2Value: number;
  gameNumber: number;
}

/** The room every viewer of a given tournament joins. Both the coarse
 *  "something changed" signal and the live tracker values are sent here. */
function tournamentRoom(tournamentId: string): string {
  return `tournament:${tournamentId}`;
}

/** A private room per signed-in user. Only a socket whose token cookie verified
 *  is ever placed in one, so anything emitted here is safe to treat as reaching
 *  that person and nobody else. */
function userRoom(userId: string): string {
  return `user:${userId}`;
}

/** What a client receives when a new notification is written for them. Carries
 *  the row itself so the bell can prepend it without a refetch. */
export interface NotificationPayload {
  id: string;
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  createdAt: Date | string;
}

/** Pulls the JWT out of the raw Cookie header sent during the socket
 *  handshake. cookie-parser only runs on HTTP requests, so the socket
 *  handshake has to read the header itself. */
function readTokenCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'token') return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/** Origins allowed to receive a visitor's PRIVATE notification stream.
 *
 *  SOCKET SECURITY — cross-origin socket hijacking. Read this before changing
 *  the CORS option below or the cookie settings in `auth.service.ts`.
 *
 *  Set `SOCKET_ALLOWED_ORIGINS` to a comma-separated list to override. The
 *  defaults cover local development and the production site; `HOST_IP` is
 *  included because `npm run setup` points the dev frontend at the LAN IP. */
function allowedOrigins(): string[] {
  const configured = process.env.SOCKET_ALLOWED_ORIGINS;
  if (configured) {
    return configured
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  }
  const hostIp = process.env.HOST_IP;
  return [
    'https://joust.escillex.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    ...(hostIp ? [`http://${hostIp}:3000`] : []),
  ];
}

/** Whether this handshake came from a page we are willing to hand a visitor's
 *  own notifications to.
 *
 *  Deliberately strict about a MISSING origin: browsers always send `Origin` on
 *  both the WebSocket upgrade and the polling handshake, so absence means a
 *  non-browser client, and this app has no such client. The private room is not
 *  the place to be permissive. */
function isTrustedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  return allowedOrigins().includes(origin);
}

// The gateway is a receive-only broadcast channel for the frontend: clients
// subscribe to a tournament and listen for updates, but never change state
// over the socket. Every state change still goes through the guarded HTTP
// endpoints, so no authorization logic is duplicated here.
@WebSocketGateway({
  // SOCKET SECURITY: this reflects any origin, which is intentional and safe
  // ONLY for the public tournament rooms — that data is already served to
  // anyone over unguarded HTTP GETs. It is deliberately NOT the control that
  // protects the private `user:<id>` room; see `isTrustedOrigin` and its use in
  // `handleConnection`. Two reasons this option cannot be that control:
  //   1. Browsers do not apply CORS to WebSocket upgrades at all, so tightening
  //      this would still leave the pure-WS transport wide open.
  //   2. Rejecting unknown origins here would break anonymous spectators, who
  //      are supposed to be able to watch a bracket without signing in.
  cors: { origin: true, credentials: true },
})
export class RealtimeGateway implements OnGatewayConnection {
  private readonly logger = new Logger('RealtimeGateway');

  @WebSocketServer()
  server!: Server;

  constructor(private readonly jwt: JwtService) {}

  handleConnection(client: Socket) {
    // Tournament and tracker data is already public over HTTP, so listening
    // does not require a login: spectators and un-logged-in guests need live
    // updates too. If a valid token cookie is present we attach the identity
    // for possible future use, but a missing or bad token never rejects the
    // connection — the socket simply stays an anonymous listener.
    // Resolved outside the catch on purpose: the catch below exists to ignore a
    // BAD TOKEN, and a misconfigured secret must not be quietly reinterpreted as
    // "this visitor is anonymous" — that would turn a deployment error into
    // silently broken notifications for everyone. Bootstrap already validated
    // this, so in practice it never throws here.
    const secret = requireJwtSecret();
    try {
      const token = readTokenCookie(client.handshake.headers.cookie);
      if (token) {
        const user = this.jwt.verify<{ id?: string }>(token, { secret });
        client.data.user = user;

        // SOCKET SECURITY — the private-room gate. Joining `user:<id>` streams
        // that person's notifications to this socket, so it happens only for a
        // handshake from an origin we trust.
        //
        // Today the cookie is `sameSite: 'lax'` (auth.service.ts), which already
        // stops a cross-site handshake from carrying it at all — so in the
        // current configuration `token` would simply be absent and we would
        // never get here. This check exists so that protection is not the ONLY
        // one: the moment that cookie is relaxed to `sameSite: 'none'` (a real
        // possibility if the frontend is ever served from a different origin
        // than the API) an attacker's page could otherwise open a socket with a
        // visitor's cookie and silently receive their whole notification feed.
        //
        // Failing this check is not an error and does not drop the connection:
        // the socket stays a normal anonymous listener and can still watch any
        // tournament, which is public data either way.
        if (user?.id && isTrustedOrigin(client.handshake.headers.origin)) {
          void client.join(userRoom(user.id));
        } else if (user?.id) {
          this.logger.warn(
            `Refused private notification room for user ${user.id}: untrusted socket origin ${client.handshake.headers.origin ?? '(none)'}`,
          );
        }
      }
    } catch {
      // Invalid token: ignore and keep the connection as an anonymous listener.
    }
  }

  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() tournamentId: string,
  ) {
    if (typeof tournamentId === 'string' && tournamentId.length > 0) {
      void client.join(tournamentRoom(tournamentId));
    }
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() tournamentId: string,
  ) {
    if (typeof tournamentId === 'string' && tournamentId.length > 0) {
      void client.leave(tournamentRoom(tournamentId));
    }
  }

  // ─── Server-side emit helpers (called from services after a DB write) ───

  /** Coarse "something in this tournament changed" signal. Listeners react by
   *  refetching through their existing data-loading function. Safe to call
   *  more than once for a single change — each call is just a refresh nudge. */
  emitTournamentUpdated(tournamentId: string): void {
    this.server
      .to(tournamentRoom(tournamentId))
      .emit('tournament:updated', { tournamentId });
  }

  /** Live tracker values for one match. Carries the payload so listeners can
   *  update the HP/points bars directly without a refetch. */
  emitTrackerUpdate(tournamentId: string, payload: TrackerUpdatePayload): void {
    this.server
      .to(tournamentRoom(tournamentId))
      .emit('tracker:update', payload);
  }

  /** Delivers one new notification to a single user, on any page they have open. */
  emitNotification(userId: string, payload: NotificationPayload): void {
    this.server.to(userRoom(userId)).emit('notification:new', payload);
  }

  /** Shared match-utilities state (timer / coin / dice) for one match, pushed to
   *  everyone viewing the tournament so open panels update without a refetch. */
  emitUtilityUpdate(
    tournamentId: string,
    payload: { matchId: string; state: unknown },
  ): void {
    this.server
      .to(tournamentRoom(tournamentId))
      .emit('utility:update', payload);
  }
}
