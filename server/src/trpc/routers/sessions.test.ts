import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { TRPCError } from '@trpc/server';

import { MemorySessionStore } from '../../lib/memorySessionStore.js';
import { SESSION_TERMINATED_MESSAGE, SessionManager, type EndedSession } from '../../lib/sessions.js';
import type { Context } from '../context.js';

// trpc.ts validates the environment when it is imported. These tests use an
// in-memory session store — no database and no real secrets.
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.ARGON2_PEPPER ??= 'test-only-pepper-00000000000000000000000';
process.env.ACCESS_TOKEN_SECRET ??= 'test-only-access-token-secret-000000000';

const { sessionsRouter } = await import('./sessions.js');
const { createCallerFactory } = await import('../trpc.js');
const { __resetRateLimitsForTest } = await import('../../lib/rateLimit.js');

const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ALICE_PHONE = 'a0000000-0000-4000-8000-000000000001';
const ALICE_LAPTOP = 'a0000000-0000-4000-8000-000000000002';
const ALICE_TABLET = 'a0000000-0000-4000-8000-000000000003';
const BOB_PHONE = 'b0000000-0000-4000-8000-000000000001';
const DAY = 24 * 60 * 60 * 1000;

let store: MemorySessionStore;
let manager: SessionManager;
let ended: EndedSession[];

const createCaller = createCallerFactory(sessionsRouter);

function callerFor(userId: string | null, deviceId: string | null) {
  const ctx = {
    req: { ip: '203.0.113.9' },
    res: {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    db: {},
    user: userId ? { id: userId } : null,
    device: deviceId ? { id: deviceId } : null,
    sessions: manager,
  };
  return createCaller(ctx as unknown as Context);
}

function trpcError(code: TRPCError['code']) {
  return (err: unknown) => err instanceof TRPCError && err.code === code;
}

function terminatedError(err: unknown) {
  return err instanceof TRPCError && err.code === 'UNAUTHORIZED' && err.message === SESSION_TERMINATED_MESSAGE;
}

beforeEach(() => {
  __resetRateLimitsForTest();
  store = new MemorySessionStore();
  ended = [];
  manager = new SessionManager(store, {
    isOnline: () => false,
    onRevoked: (sessions) => ended.push(...sessions),
    onNewLogin: () => {},
  });
  const now = Date.now();
  store.addDevice({ id: ALICE_PHONE, userId: ALICE, model: 'Pixel 8', osVersion: 'Android 15', appVersion: '0.9.0', lastSeenAt: new Date(now) });
  store.addDevice({ id: ALICE_LAPTOP, userId: ALICE, name: 'Web browser', platform: 'web', lastSeenAt: new Date(now - DAY) });
  store.addDevice({ id: BOB_PHONE, userId: BOB, lastSeenAt: new Date(now) });
});

describe('sessions.list / sessions.get', () => {
  test("lists the caller's own sessions and identifies this device", async () => {
    const result = await callerFor(ALICE, ALICE_PHONE).list();
    assert.equal(result.currentSessionId, ALICE_PHONE);
    assert.equal(result.autoTerminateDays, 180);
    assert.deepEqual(
      result.sessions.map((session) => [session.id, session.isCurrent]),
      [
        [ALICE_PHONE, true],
        [ALICE_LAPTOP, false],
      ],
    );
  });

  test("returns details of the caller's own session; another account's session is not found", async () => {
    const { session } = await callerFor(ALICE, ALICE_PHONE).get({ sessionId: ALICE_LAPTOP.toUpperCase() });
    assert.equal(session.id, ALICE_LAPTOP);
    assert.equal(session.platform, 'web');
    assert.ok(session.firstLoginAt && session.lastActiveAt);
    await assert.rejects(callerFor(BOB, BOB_PHONE).get({ sessionId: ALICE_LAPTOP }), trpcError('NOT_FOUND'));
  });
});

describe('sessions.terminate', () => {
  test('terminates another session, which immediately loses API access', async () => {
    assert.equal((await callerFor(ALICE, ALICE_LAPTOP).list()).sessions.length, 2);
    assert.deepEqual(await callerFor(ALICE, ALICE_PHONE).terminate({ sessionId: ALICE_LAPTOP }), { terminated: true });

    await assert.rejects(callerFor(ALICE, ALICE_LAPTOP).list(), terminatedError);
    assert.deepEqual(ended, [{ deviceId: ALICE_LAPTOP, userId: ALICE }]);
    const { sessions } = await callerFor(ALICE, ALICE_PHONE).list();
    assert.deepEqual(
      sessions.map((session) => session.id),
      [ALICE_PHONE],
    );
  });

  test("can't end this device from the list, or any session of another account", async () => {
    await assert.rejects(callerFor(ALICE, ALICE_PHONE).terminate({ sessionId: ALICE_PHONE }), trpcError('BAD_REQUEST'));
    await assert.rejects(callerFor(BOB, BOB_PHONE).terminate({ sessionId: ALICE_LAPTOP }), trpcError('NOT_FOUND'));
    assert.equal((await callerFor(ALICE, ALICE_LAPTOP).list()).sessions.length, 2);
    assert.deepEqual(ended, []);
  });
});

describe('sessions.terminateAllOthers', () => {
  test('ends every other session of the account and keeps this one', async () => {
    store.addDevice({ id: ALICE_TABLET, userId: ALICE, lastSeenAt: new Date() });
    assert.deepEqual(await callerFor(ALICE, ALICE_PHONE).terminateAllOthers(), { terminatedCount: 2 });

    const { sessions } = await callerFor(ALICE, ALICE_PHONE).list();
    assert.deepEqual(
      sessions.map((session) => session.id),
      [ALICE_PHONE],
    );
    await assert.rejects(callerFor(ALICE, ALICE_LAPTOP).list(), terminatedError);
    await assert.rejects(callerFor(ALICE, ALICE_TABLET).list(), terminatedError);
    assert.equal((await callerFor(BOB, BOB_PHONE).list()).sessions.length, 1);
  });
});

describe('sessions.setAutoTerminate', () => {
  test('validates the period', async () => {
    for (const days of [0, 6, 731, 10.5]) {
      await assert.rejects(callerFor(ALICE, ALICE_PHONE).setAutoTerminate({ days }), trpcError('BAD_REQUEST'), String(days));
    }
  });

  test('saves the period and ends other sessions already idle that long, never this device', async () => {
    const laptop = store.devices.get(ALICE_LAPTOP);
    const phone = store.devices.get(ALICE_PHONE);
    assert.ok(laptop && phone);
    laptop.lastSeenAt = new Date(Date.now() - 10 * DAY);

    assert.deepEqual(await callerFor(ALICE, ALICE_PHONE).setAutoTerminate({ days: 7 }), { autoTerminateDays: 7, terminatedCount: 1 });
    assert.equal((await callerFor(ALICE, ALICE_PHONE).list()).autoTerminateDays, 7);
    await assert.rejects(callerFor(ALICE, ALICE_LAPTOP).list(), terminatedError);
    assert.equal(phone.revokedAt, null);
  });

  test('a session idle past the setting loses access on its next request', async () => {
    store.ttlDays.set(ALICE, 7);
    const laptop = store.devices.get(ALICE_LAPTOP);
    assert.ok(laptop);
    laptop.lastSeenAt = new Date(Date.now() - 8 * DAY);
    await assert.rejects(callerFor(ALICE, ALICE_LAPTOP).list(), terminatedError);
    assert.deepEqual(ended, [{ deviceId: ALICE_LAPTOP, userId: ALICE }]);
  });
});

describe('sessions authorization', () => {
  test('every procedure requires a signed-in session', async () => {
    const anonymous = callerFor(null, null);
    await assert.rejects(anonymous.list(), trpcError('UNAUTHORIZED'));
    await assert.rejects(anonymous.get({ sessionId: ALICE_LAPTOP }), trpcError('UNAUTHORIZED'));
    await assert.rejects(anonymous.terminate({ sessionId: ALICE_LAPTOP }), trpcError('UNAUTHORIZED'));
    await assert.rejects(anonymous.terminateAllOthers(), trpcError('UNAUTHORIZED'));
    await assert.rejects(anonymous.setAutoTerminate({ days: 30 }), trpcError('UNAUTHORIZED'));
    assert.deepEqual(ended, []);
  });

  test("a token pairing one account with another account's device is refused", async () => {
    await assert.rejects(callerFor(ALICE, BOB_PHONE).list(), terminatedError);
    await assert.rejects(callerFor(ALICE, BOB_PHONE).terminateAllOthers(), terminatedError);
    assert.deepEqual(ended, []);
  });
});
