import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MemorySessionStore } from './memorySessionStore.js';
import type { NewLoginNotice } from './newLogin.js';
import {
  SESSION_TTL_MAX_DAYS,
  SESSION_TTL_MIN_DAYS,
  SessionManager,
  TOUCH_INTERVAL_MS,
  VERIFIED_CACHE_MS,
  isSessionExpired,
  truncateIp,
  type EndedSession,
} from './sessions.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-14T12:00:00Z');

function setup() {
  let clock = NOW;
  const store = new MemorySessionStore();
  const ended: EndedSession[] = [];
  const online = new Set<string>();
  const logins: { userId: string; notice: NewLoginNotice }[] = [];
  const manager = new SessionManager(
    store,
    {
      isOnline: (deviceId) => online.has(deviceId),
      onRevoked: (sessions) => ended.push(...sessions),
      onNewLogin: (userId, notice) => logins.push({ userId, notice }),
    },
    undefined,
    () => clock,
  );
  const ago = (ms: number) => new Date(NOW - ms);
  store.addDevice({
    id: 'alice-phone',
    userId: 'alice',
    model: 'Pixel 8',
    osVersion: 'Android 15',
    appVersion: '0.9.0',
    createdAt: ago(10 * DAY),
    lastSeenAt: ago(0),
  });
  store.addDevice({
    id: 'alice-laptop',
    userId: 'alice',
    name: 'Web browser',
    platform: 'web',
    createdAt: ago(5 * DAY),
    lastSeenAt: ago(2 * DAY),
    lastIpPrefix: '203.0.113.*',
    pushToken: 'synthetic-push-token',
  });
  store.addDevice({
    id: 'alice-old',
    userId: 'alice',
    createdAt: ago(40 * DAY),
    lastSeenAt: ago(40 * DAY),
    revokedAt: ago(20 * DAY),
    refreshTokenHash: null,
    refreshTokenExpiresAt: null,
  });
  store.addDevice({ id: 'bob-phone', userId: 'bob', createdAt: ago(3 * DAY), lastSeenAt: ago(DAY) });
  return {
    store,
    manager,
    ended,
    online,
    logins,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('truncateIp', () => {
  test('keeps only the network: IPv4 /24 and IPv6 /48', () => {
    assert.equal(truncateIp('203.0.113.77'), '203.0.113.*');
    assert.equal(truncateIp('::ffff:198.51.100.7'), '198.51.100.*');
    assert.equal(truncateIp('2001:0db8:85a3:08d3:1319:8a2e:0370:7348'), '2001:db8:85a3:*');
    assert.equal(truncateIp('2001:db8::1'), '2001:db8:0:*');
  });

  test('stores nothing for missing or invalid addresses', () => {
    for (const value of [undefined, null, '', 'not-an-ip', '999.1.1.1', '1:2:3', '1::2::3']) {
      assert.equal(truncateIp(value), null, String(value));
    }
  });
});

describe('isSessionExpired', () => {
  test('compares idle time with the setting', () => {
    assert.equal(isSessionExpired(new Date(NOW - 6 * DAY), 7, NOW), false);
    assert.equal(isSessionExpired(new Date(NOW - 8 * DAY), 7, NOW), true);
  });
});

describe('SessionManager — listing and details', () => {
  test("lists only the account's live sessions, this device first, with no credentials", async () => {
    const { manager } = setup();
    const sessions = await manager.list('alice', 'alice-phone');
    assert.deepEqual(
      sessions.map((session) => [session.id, session.isCurrent]),
      [
        ['alice-phone', true],
        ['alice-laptop', false],
      ],
    );
    assert.deepEqual(Object.keys(sessions[0] ?? {}).sort(), [
      'appVersion',
      'deviceName',
      'firstLoginAt',
      'id',
      'ipAddress',
      'isCurrent',
      'lastActiveAt',
      'location',
      'model',
      'online',
      'osVersion',
      'platform',
    ]);
    const serialized = JSON.stringify(sessions);
    assert.equal(serialized.includes('synthetic-refresh-token-hash'), false);
    assert.equal(serialized.includes('synthetic-push-token'), false);
  });

  test('describes each session: current device online, others by realtime presence, truncated network, no location', async () => {
    const { manager, online } = setup();
    let [current, laptop] = await manager.list('alice', 'alice-phone');
    assert.equal(current?.online, true);
    assert.equal(current?.deviceName, 'Pixel 8');
    assert.equal(current?.lastActiveAt, new Date(NOW).toISOString());
    assert.equal(laptop?.online, false);
    assert.equal(laptop?.ipAddress, '203.0.113.*');
    assert.equal(laptop?.location, null);
    assert.equal(laptop?.lastActiveAt, new Date(NOW - 2 * DAY).toISOString());

    online.add('alice-laptop');
    [current, laptop] = await manager.list('alice', 'alice-phone');
    assert.equal(laptop?.online, true);
  });

  test("shows a session's details only to its own account", async () => {
    const { manager } = setup();
    assert.equal((await manager.get('alice', 'alice-phone', 'alice-laptop'))?.deviceName, 'Web browser');
    assert.equal(await manager.get('bob', 'bob-phone', 'alice-laptop'), null);
    assert.equal(await manager.get('alice', 'alice-phone', 'alice-old'), null);
  });
});

describe('SessionManager — terminating', () => {
  test('terminating one session revokes it server-side, clears its credentials and tears it down', async () => {
    const { manager, store, ended } = setup();
    assert.equal(await manager.terminate('alice', 'alice-phone', 'alice-laptop'), 'terminated');

    const row = store.devices.get('alice-laptop');
    assert.ok(row?.revokedAt);
    assert.equal(row?.refreshTokenHash, null);
    assert.equal(row?.refreshTokenExpiresAt, null);
    assert.equal(row?.pushToken, null);
    assert.deepEqual(ended, [{ deviceId: 'alice-laptop', userId: 'alice' }]);
    assert.deepEqual(
      (await manager.list('alice', 'alice-phone')).map((session) => session.id),
      ['alice-phone'],
    );
  });

  test("refuses to end the current session from the list, and can't touch another account's sessions", async () => {
    const { manager, ended } = setup();
    assert.equal(await manager.terminate('alice', 'alice-phone', 'alice-phone'), 'current');
    assert.equal(await manager.terminate('bob', 'bob-phone', 'alice-laptop'), 'not_found');
    assert.equal(await manager.isActive('alice', 'alice-laptop'), true);
    assert.equal(await manager.isActive('alice', 'alice-phone'), true);
    assert.deepEqual(ended, []);
  });

  test('terminating all other sessions keeps this one', async () => {
    const { manager, store } = setup();
    store.addDevice({ id: 'alice-tablet', userId: 'alice', lastSeenAt: new Date(NOW - DAY) });
    assert.equal(await manager.terminateAllOthers('alice', 'alice-phone'), 2);
    assert.equal(await manager.isActive('alice', 'alice-phone'), true);
    assert.equal(await manager.isActive('alice', 'alice-laptop'), false);
    assert.equal(await manager.isActive('alice', 'alice-tablet'), false);
    assert.equal(await manager.isActive('bob', 'bob-phone'), true);
    assert.deepEqual(
      (await manager.list('alice', 'alice-phone')).map((session) => session.id),
      ['alice-phone'],
    );
  });

  test('a terminated session fails the active check at once, even while its "active" answer is cached', async () => {
    const { manager } = setup();
    assert.equal(await manager.isActive('alice', 'alice-laptop'), true);
    await manager.terminate('alice', 'alice-phone', 'alice-laptop');
    assert.equal(await manager.isActive('alice', 'alice-laptop'), false);
    assert.equal(manager.isKnownRevoked('alice-laptop'), true);
  });

  test('a session terminated by another process is noticed once the short cache expires', async () => {
    const { manager, store, advance } = setup();
    assert.equal(await manager.isActive('alice', 'alice-laptop'), true);
    const row = store.devices.get('alice-laptop');
    assert.ok(row);
    row.revokedAt = new Date(NOW);
    advance(VERIFIED_CACHE_MS + 1);
    assert.equal(await manager.isActive('alice', 'alice-laptop'), false);
  });

  test('rejects unknown devices, already-revoked ones, and a device checked against the wrong account', async () => {
    const { manager } = setup();
    assert.equal(await manager.isActive('alice', 'no-such-device'), false);
    assert.equal(await manager.isActive('alice', 'alice-old'), false);
    assert.equal(await manager.isActive('alice', 'bob-phone'), false);
  });
});

describe('SessionManager — automatic termination', () => {
  test('a session idle longer than the setting is ended on its next check', async () => {
    const { manager, store, ended, advance } = setup();
    store.ttlDays.set('alice', 7);
    assert.equal(await manager.isActive('alice', 'alice-laptop'), true);
    advance(6 * DAY + VERIFIED_CACHE_MS);
    assert.equal(await manager.isActive('alice', 'alice-laptop'), false);
    assert.deepEqual(ended, [{ deviceId: 'alice-laptop', userId: 'alice' }]);
  });

  test("the periodic sweep ends only sessions idle past their own account's setting", async () => {
    const { manager, store, ended, advance } = setup();
    store.ttlDays.set('alice', 7);
    advance(6 * DAY);
    // alice-phone idle 6 days, alice-laptop 8 days (limit 7); bob-phone 7 days (limit 180).
    assert.equal(await manager.sweepInactive(), 1);
    assert.deepEqual(ended, [{ deviceId: 'alice-laptop', userId: 'alice' }]);
  });

  test('changing the setting validates it, applies it at once, and never ends this device', async () => {
    const { manager, store } = setup();
    for (const days of [SESSION_TTL_MIN_DAYS - 1, SESSION_TTL_MAX_DAYS + 1, 7.5]) {
      await assert.rejects(manager.setAutoTerminateDays('alice', 'alice-phone', days), RangeError);
    }
    assert.equal(await manager.getAutoTerminateDays('alice'), 180);

    // Make both look idle for 10 days: only the other one may be ended.
    const phone = store.devices.get('alice-phone');
    const laptop = store.devices.get('alice-laptop');
    assert.ok(phone && laptop);
    phone.lastSeenAt = new Date(NOW - 10 * DAY);
    laptop.lastSeenAt = new Date(NOW - 10 * DAY);

    assert.equal(await manager.setAutoTerminateDays('alice', 'alice-phone', 7), 1);
    assert.equal(await manager.getAutoTerminateDays('alice'), 7);
    assert.equal(phone.revokedAt, null);
    assert.ok(laptop.revokedAt);
    assert.equal(await manager.isActive('bob', 'bob-phone'), true);
  });
});

describe('SessionManager — activity and new logins', () => {
  test('records activity at most once a minute, storing only a truncated network', async () => {
    const { manager, store, advance } = setup();
    const laptop = store.devices.get('alice-laptop');
    assert.ok(laptop);

    manager.touch('alice-laptop', '198.51.100.23');
    assert.equal(laptop.lastSeenAt.getTime(), NOW);
    assert.equal(laptop.lastIpPrefix, '198.51.100.*');

    advance(1000);
    manager.touch('alice-laptop', '192.0.2.1');
    assert.equal(laptop.lastIpPrefix, '198.51.100.*');

    advance(TOUCH_INTERVAL_MS);
    manager.touch('alice-laptop', '192.0.2.1');
    assert.equal(laptop.lastIpPrefix, '192.0.2.*');
    assert.equal(laptop.lastSeenAt.getTime(), NOW + 1000 + TOUCH_INTERVAL_MS);
  });

  test('hands a new login to the notifier', () => {
    const { manager, logins } = setup();
    const notice: NewLoginNotice = { sessionId: 'alice-new', deviceName: 'Pixel 9', platform: 'android', location: null, at: new Date(NOW).toISOString() };
    manager.announceNewLogin('alice', notice);
    assert.deepEqual(logins, [{ userId: 'alice', notice }]);
  });
});
