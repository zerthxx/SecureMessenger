import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import fastify, { type FastifyInstance } from 'fastify';

import { AVATAR_MAX_BYTES } from '../lib/profile.js';
import { __resetRateLimitsForTest } from '../lib/rateLimit.js';
import { avatarRoutes } from './avatars.js';

const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const ACCOUNTS: Record<string, { userId: string; deviceId: string }> = {
  'token-alice': { userId: ALICE, deviceId: 'alice-phone' },
  'token-bob': { userId: BOB, deviceId: 'bob-phone' },
  'token-alice-revoked': { userId: ALICE, deviceId: 'revoked-device' },
};

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(256, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(256, 9)]);

describe('avatar routes', () => {
  let app: FastifyInstance;
  let avatarIds: Map<string, string | null>;
  let blobs: Map<string, Buffer>;

  beforeEach(async () => {
    __resetRateLimitsForTest();
    avatarIds = new Map([
      [ALICE, null],
      [BOB, null],
    ]);
    blobs = new Map();
    app = fastify();
    app.register(avatarRoutes, {
      prefix: '/avatars',
      authenticate: async (req) => ACCOUNTS[(req.headers.authorization ?? '').replace(/^Bearer /, '')] ?? null,
      isDeviceActive: async (deviceId) => deviceId !== 'revoked-device',
      profiles: {
        async findById(userId) {
          if (!avatarIds.has(userId)) return null;
          return {
            id: userId,
            username: 'user',
            displayName: 'User',
            bio: null,
            birthday: null,
            birthdayVisibility: 'month_day',
            avatarId: avatarIds.get(userId) ?? null,
          };
        },
        async setAvatar(userId, avatarId) {
          if (!avatarIds.has(userId)) return null;
          const previousAvatarId = avatarIds.get(userId) ?? null;
          avatarIds.set(userId, avatarId);
          return { previousAvatarId };
        },
      },
      blobs: {
        async save(avatarId, bytes) {
          blobs.set(avatarId, bytes);
        },
        async read(avatarId) {
          return blobs.get(avatarId) ?? null;
        },
        async remove(avatarId) {
          blobs.delete(avatarId);
        },
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  function authHeader(token: string | null): Record<string, string> {
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  function upload(token: string | null, payload: Buffer, contentType = 'image/jpeg') {
    return app.inject({ method: 'PUT', url: '/avatars', headers: { ...authHeader(token), 'content-type': contentType }, payload });
  }

  function fetchAvatar(token: string | null, userId: string, avatarId: string) {
    return app.inject({ method: 'GET', url: `/avatars/${userId}/${avatarId}`, headers: authHeader(token) });
  }

  test('uploads a photo and serves it to another signed-in user, cacheable indefinitely', async () => {
    const res = await upload('token-alice', JPEG);
    assert.equal(res.statusCode, 201);
    const { avatarId } = res.json() as { avatarId: string };
    assert.equal(avatarIds.get(ALICE), avatarId);
    assert.deepEqual(blobs.get(avatarId), JPEG);

    const served = await fetchAvatar('token-bob', ALICE, avatarId);
    assert.equal(served.statusCode, 200);
    assert.equal(served.headers['content-type'], 'image/jpeg');
    assert.match(String(served.headers['cache-control']), /immutable/);
    assert.deepEqual(served.rawPayload, JPEG);
  });

  test('replacing a photo deletes the old file and stops serving the old id', async () => {
    const first = (await upload('token-alice', JPEG)).json() as { avatarId: string };
    const second = (await upload('token-alice', PNG, 'image/png')).json() as { avatarId: string };
    assert.notEqual(first.avatarId, second.avatarId);
    assert.deepEqual([...blobs.keys()], [second.avatarId]);

    assert.equal((await fetchAvatar('token-bob', ALICE, first.avatarId)).statusCode, 404);
    const current = await fetchAvatar('token-bob', ALICE, second.avatarId);
    assert.equal(current.statusCode, 200);
    assert.equal(current.headers['content-type'], 'image/png');
  });

  test('removing a photo clears it', async () => {
    const { avatarId } = (await upload('token-alice', JPEG)).json() as { avatarId: string };
    const res = await app.inject({ method: 'DELETE', url: '/avatars', headers: authHeader('token-alice') });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { avatarId: null });
    assert.equal(avatarIds.get(ALICE), null);
    assert.equal(blobs.size, 0);
    assert.equal((await fetchAvatar('token-bob', ALICE, avatarId)).statusCode, 404);
  });

  test('a user can only change their own photo', async () => {
    await upload('token-bob', JPEG);
    assert.equal(avatarIds.get(ALICE), null);
    await app.inject({ method: 'DELETE', url: '/avatars', headers: authHeader('token-alice') });
    assert.notEqual(avatarIds.get(BOB), null);
  });

  test('every route requires authentication, checked before an upload is read', async () => {
    assert.equal((await upload(null, JPEG)).statusCode, 401);
    assert.equal((await upload('not-a-real-token', JPEG)).statusCode, 401);
    assert.equal((await app.inject({ method: 'DELETE', url: '/avatars' })).statusCode, 401);
    assert.equal((await fetchAvatar(null, ALICE, BOB)).statusCode, 401);
    // Even an oversized body is refused as unauthenticated, not parsed first.
    assert.equal((await upload(null, Buffer.alloc(AVATAR_MAX_BYTES + 1))).statusCode, 401);
    assert.equal(blobs.size, 0);
  });

  test('rejects uploads from a signed-out device', async () => {
    assert.equal((await upload('token-alice-revoked', JPEG)).statusCode, 401);
    assert.equal(blobs.size, 0);
    assert.equal(avatarIds.get(ALICE), null);
  });

  test('rejects files that are not images, or whose bytes do not match the declared type', async () => {
    assert.equal((await upload('token-alice', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).statusCode, 415);
    assert.equal((await upload('token-alice', PNG, 'image/jpeg')).statusCode, 415);
    assert.equal((await upload('token-alice', JPEG, 'image/svg+xml')).statusCode, 415);
    assert.equal(blobs.size, 0);
    assert.equal(avatarIds.get(ALICE), null);
  });

  test('rejects photos over the size limit', async () => {
    const oversized = Buffer.concat([JPEG, Buffer.alloc(AVATAR_MAX_BYTES)]);
    assert.equal((await upload('token-alice', oversized)).statusCode, 413);
    assert.equal(blobs.size, 0);
  });

  test('rejects malformed ids and answers 404 for users without that photo', async () => {
    assert.equal((await fetchAvatar('token-bob', 'alice', 'photo')).statusCode, 400);
    assert.equal((await fetchAvatar('token-bob', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', ALICE)).statusCode, 404);
    assert.equal((await fetchAvatar('token-bob', ALICE, BOB)).statusCode, 404);
  });
});
