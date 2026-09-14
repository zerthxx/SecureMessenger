import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import websocket from '@fastify/websocket';
import fastify, { type FastifyInstance } from 'fastify';
import type WebSocket from 'ws';

import { __resetRateLimitsForTest } from '../lib/rateLimit.js';
import { CallRegistry } from '../realtime/callRegistry.js';
import { RealtimeHub } from '../realtime/hub.js';
import type { ServerEvent } from '../realtime/protocol.js';
import { realtimeRoutes } from './realtime.js';

const CALL = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const OTHER_CONVERSATION = '33333333-3333-4333-8333-333333333333';

const ACCOUNTS: Record<string, { userId: string; deviceId: string }> = {
  'token-alice': { userId: 'user-alice', deviceId: 'alice-phone' },
  'token-bob': { userId: 'user-bob', deviceId: 'bob-phone' },
  'token-revoked': { userId: 'user-bob', deviceId: 'revoked-device' },
};

/** Collects a socket's events so a test can await the next one of a given type. */
function listen(socket: WebSocket) {
  const received: ServerEvent[] = [];
  const waiters: { type: string; resolve: (event: ServerEvent) => void }[] = [];
  socket.on('message', (data) => {
    const event = JSON.parse(String(data)) as ServerEvent;
    const index = waiters.findIndex((waiter) => waiter.type === event.type);
    if (index >= 0) {
      waiters.splice(index, 1)[0]?.resolve(event);
    } else {
      received.push(event);
    }
  });
  return {
    next(type: ServerEvent['type']): Promise<ServerEvent> {
      const index = received.findIndex((event) => event.type === type);
      if (index >= 0) return Promise.resolve(received.splice(index, 1)[0] as ServerEvent);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 2000);
        waiters.push({
          type,
          resolve: (event) => {
            clearTimeout(timer);
            resolve(event);
          },
        });
      });
    },
  };
}

describe('realtime route', () => {
  let app: FastifyInstance;
  const sockets: WebSocket[] = [];

  async function connect(token: string) {
    const socket = await app.injectWS('/realtime', { headers: { authorization: `Bearer ${token}` } });
    sockets.push(socket);
    const events = listen(socket);
    const send = (message: object) => socket.send(JSON.stringify(message));
    // A pong proves the server has registered this device (and that no
    // earlier frame, like 'ready', was missed before listening started).
    send({ type: 'ping' });
    await events.next('pong');
    return { socket, events, send };
  }

  beforeEach(async () => {
    __resetRateLimitsForTest();
    const hub = new RealtimeHub();
    const calls = new CallRegistry({
      toDevice: (deviceId, event) => hub.toDevice(deviceId, event),
      toUser: (userId, event, options) => hub.toUser(userId, event, options),
      wakeCallee: () => {},
      cancelWake: () => {},
    });
    app = fastify();
    await app.register(websocket);
    await app.register(realtimeRoutes, {
      hub,
      calls,
      authenticate: async (token) => {
        const account = ACCOUNTS[token];
        return account ? { ...account, expiresAt: Date.now() + 60_000 } : null;
      },
      isDeviceActive: async (deviceId) => deviceId !== 'revoked-device',
      findCallee: async (conversationId, userId) => {
        if (conversationId !== CONVERSATION) return null;
        return userId === 'user-alice' ? 'user-bob' : userId === 'user-bob' ? 'user-alice' : null;
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await app.close();
  });

  test('refuses the upgrade without a valid token or for a revoked device', async () => {
    await assert.rejects(app.injectWS('/realtime', { headers: {} }), /401/);
    await assert.rejects(app.injectWS('/realtime', { headers: { authorization: 'Bearer forged' } }), /401/);
    await assert.rejects(app.injectWS('/realtime', { headers: { authorization: 'Bearer token-revoked' } }), /401/);
  });

  test('relays a whole call between two authenticated devices without touching payloads', async () => {
    const alice = await connect('token-alice');
    const bob = await connect('token-bob');

    alice.send({ type: 'call.invite', callId: CALL, conversationId: CONVERSATION, media: 'audio', payload: 'b2ZmZXI=' });
    const incoming = await bob.events.next('call.incoming');
    assert.deepEqual(
      { ...incoming, startedAt: undefined },
      { type: 'call.incoming', callId: CALL, conversationId: CONVERSATION, callerUserId: 'user-alice', media: 'audio', payload: 'b2ZmZXI=', startedAt: undefined },
    );

    alice.send({ type: 'call.signal', callId: CALL, payload: 'Y2FuZGlkYXRl' });
    assert.deepEqual(await bob.events.next('call.signal'), { type: 'call.signal', callId: CALL, payload: 'Y2FuZGlkYXRl' });

    bob.send({ type: 'call.ringing', callId: CALL });
    assert.deepEqual(await alice.events.next('call.ringing'), { type: 'call.ringing', callId: CALL });

    bob.send({ type: 'call.accept', callId: CALL, payload: 'YW5zd2Vy' });
    assert.deepEqual(await alice.events.next('call.accepted'), { type: 'call.accepted', callId: CALL, payload: 'YW5zd2Vy' });

    bob.send({ type: 'call.hangup', callId: CALL });
    assert.deepEqual(await alice.events.next('call.ended'), { type: 'call.ended', callId: CALL, reason: 'hangup' });
  });

  test('refuses calls into a conversation the caller is not a member of', async () => {
    const alice = await connect('token-alice');
    alice.send({ type: 'call.invite', callId: CALL, conversationId: OTHER_CONVERSATION, media: 'video', payload: 'b2ZmZXI=' });
    assert.deepEqual(await alice.events.next('call.error'), { type: 'call.error', callId: CALL, code: 'not_allowed' });
  });

  test('answers malformed frames instead of acting on them, and still answers pings', async () => {
    const alice = await connect('token-alice');
    alice.socket.send('definitely not json');
    assert.deepEqual(await alice.events.next('call.error'), { type: 'call.error', code: 'invalid_message' });
    alice.send({ type: 'ping' });
    assert.deepEqual(await alice.events.next('pong'), { type: 'pong' });
  });

  test('a device that fetches a call after it was cancelled is told it ended', async () => {
    const alice = await connect('token-alice');
    alice.send({ type: 'call.invite', callId: CALL, conversationId: CONVERSATION, media: 'audio', payload: 'b2ZmZXI=' });
    alice.send({ type: 'call.hangup', callId: CALL });

    // Bob comes online afterwards and asks for the call a push told him about.
    const bob = await connect('token-bob');
    bob.send({ type: 'call.fetch', callId: CALL });
    assert.deepEqual(await bob.events.next('call.ended'), { type: 'call.ended', callId: CALL, reason: 'cancelled' });
  });
});
