import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RawData } from 'ws';

import { checkRateLimit, RateLimitExceededError } from '../lib/rateLimit.js';
import type { CallParticipant, CallRegistry } from '../realtime/callRegistry.js';
import type { RealtimeConnection, RealtimeHub } from '../realtime/hub.js';
import { parseClientMessage, type ClientMessage, type ServerEvent } from '../realtime/protocol.js';

export interface RealtimeAuth {
  userId: string;
  deviceId: string;
  /** Access-token expiry, epoch milliseconds. */
  expiresAt: number;
}

export interface RealtimeRouteOptions {
  hub: RealtimeHub;
  calls: CallRegistry;
  /** Verifies an access token exactly like the HTTP API does. */
  authenticate(token: string): Promise<RealtimeAuth | null>;
  /** Whether the device's session is still live (not terminated, belongs to `userId`). */
  isDeviceActive(deviceId: string, userId: string): Promise<boolean>;
  /**
   * Synchronous: whether the session is already known to be terminated.
   * Checked on every message, so signaling stops even before a terminated
   * device's socket has finished closing.
   */
  isDeviceRevoked?(deviceId: string): boolean;
  /** The other member of a direct conversation that `userId` belongs to; null when `userId` isn't a member. */
  findCallee(conversationId: string, userId: string): Promise<string | null>;
  heartbeatMs?: number;
  now?: () => number;
}

/** A newer connection from the same device took over. */
export const CLOSE_REPLACED = 4000;
/** The access token expired; the app refreshes it and reconnects. */
export const CLOSE_TOKEN_EXPIRED = 4001;
/** The session was terminated (Settings → Devices, sign-out everywhere, inactivity). The app must not reconnect. */
export const CLOSE_SESSION_REVOKED = 4003;
const CLOSE_POLICY_VIOLATION = 1008;

const HEARTBEAT_MS = 25_000;

/**
 * `GET /realtime` — the authenticated WebSocket carrying call signaling and
 * content-free "sync now" hints (see realtime/protocol.ts).
 *
 * Authentication happens before the upgrade, with the same Bearer access
 * token and revoked-device check as the HTTP API; an unauthenticated request
 * gets a plain 401 and never a socket. The socket closes when the token
 * expires unless the app sends a fresh one (`auth.refresh`) first.
 */
export async function realtimeRoutes(app: FastifyInstance, options: RealtimeRouteOptions) {
  const { hub, calls } = options;
  const now = options.now ?? Date.now;
  const authByRequest = new WeakMap<FastifyRequest, RealtimeAuth>();

  app.get(
    '/realtime',
    {
      websocket: true,
      preValidation: async (request, reply) => {
        const header = request.headers.authorization;
        const auth = header?.startsWith('Bearer ') ? await options.authenticate(header.slice('Bearer '.length)) : null;
        if (!auth || auth.expiresAt <= now()) {
          return reply.code(401).send({ error: 'Authentication required' });
        }
        if (!(await options.isDeviceActive(auth.deviceId, auth.userId))) {
          return reply.code(401).send({ error: 'This device has been signed out.' });
        }
        authByRequest.set(request, auth);
      },
    },
    (socket, request) => {
      const auth = authByRequest.get(request);
      if (!auth) {
        socket.close(CLOSE_POLICY_VIOLATION, 'unauthenticated');
        return;
      }
      const participant: CallParticipant = { userId: auth.userId, deviceId: auth.deviceId };
      const connection: RealtimeConnection = { ...participant, socket };

      const send = (event: ServerEvent) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
      };

      const replaced = hub.add(connection);
      replaced?.socket.close(CLOSE_REPLACED, 'replaced by a newer connection');
      calls.deviceConnected(auth.deviceId);

      const closeWhenTokenExpires = (expiresAt: number) =>
        setTimeout(() => socket.close(CLOSE_TOKEN_EXPIRED, 'access token expired'), Math.max(0, expiresAt - now()));
      let expiryTimer = closeWhenTokenExpires(auth.expiresAt);

      // Drops connections whose other end vanished without a close (radio
      // off, process killed), so a device isn't counted as reachable forever.
      let alive = true;
      socket.on('pong', () => {
        alive = true;
      });
      const heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, options.heartbeatMs ?? HEARTBEAT_MS);

      async function handle(message: ClientMessage): Promise<void> {
        switch (message.type) {
          case 'ping':
            send({ type: 'pong' });
            return;
          case 'auth.refresh': {
            const next = await options.authenticate(message.token);
            if (!next || next.userId !== participant.userId || next.deviceId !== participant.deviceId || next.expiresAt <= now()) {
              socket.close(CLOSE_POLICY_VIOLATION, 'invalid token');
              return;
            }
            if (!(await options.isDeviceActive(next.deviceId, next.userId))) {
              socket.close(CLOSE_SESSION_REVOKED, 'session terminated');
              return;
            }
            clearTimeout(expiryTimer);
            expiryTimer = closeWhenTokenExpires(next.expiresAt);
            send({ type: 'auth.refreshed' });
            return;
          }
          case 'call.invite': {
            if (!allow(`realtime:invite:device:${participant.deviceId}`, 12, 60_000)) {
              send({ type: 'call.error', callId: message.callId, code: 'rate_limited' });
              return;
            }
            const calleeUserId = await options.findCallee(message.conversationId, participant.userId);
            if (!calleeUserId) {
              send({ type: 'call.error', callId: message.callId, code: 'not_allowed' });
              return;
            }
            const result = calls.invite(participant, message, calleeUserId);
            if (result === 'already_in_call') send({ type: 'call.error', callId: message.callId, code: 'already_in_call' });
            if (result === 'duplicate') send({ type: 'call.error', callId: message.callId, code: 'invalid_message' });
            return;
          }
          case 'call.fetch':
            calls.fetch(participant, message.callId);
            return;
          case 'call.ringing':
            calls.ringing(participant, message.callId);
            return;
          case 'call.accept':
            calls.accept(participant, message.callId, message.payload);
            return;
          case 'call.decline':
            calls.decline(participant, message.callId, message.busy ?? false);
            return;
          case 'call.signal':
            calls.signal(participant, message.callId, message.payload);
            return;
          case 'call.hangup':
            calls.hangup(participant, message.callId);
            return;
        }
      }

      // Strictly in arrival order: an invite waits on a database lookup, and
      // the ICE candidates sent right after it must not be routed before the
      // call exists.
      let queue: Promise<void> = Promise.resolve();
      socket.on('message', (data: RawData, isBinary: boolean) => {
        queue = queue
          .then(async () => {
            if (options.isDeviceRevoked?.(participant.deviceId)) {
              socket.close(CLOSE_SESSION_REVOKED, 'session terminated');
              return;
            }
            if (!allow(`realtime:device:${participant.deviceId}`, 240, 10_000)) {
              send({ type: 'call.error', code: 'rate_limited' });
              return;
            }
            const message = isBinary ? null : parseClientMessage(rawToString(data));
            if (!message) {
              send({ type: 'call.error', code: 'invalid_message' });
              return;
            }
            await handle(message);
          })
          .catch((err: unknown) => {
            app.log.warn({ err, deviceId: participant.deviceId }, 'realtime message handling failed');
          });
      });

      socket.on('close', () => {
        clearTimeout(expiryTimer);
        clearInterval(heartbeat);
        if (hub.remove(connection)) calls.deviceDisconnected(participant.deviceId);
      });

      send({ type: 'ready' });
    },
  );
}

function allow(key: string, max: number, windowMs: number): boolean {
  try {
    checkRateLimit(key, max, windowMs);
    return true;
  } catch (err) {
    if (err instanceof RateLimitExceededError) return false;
    throw err;
  }
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
