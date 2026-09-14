import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { TRPCError } from '@trpc/server';

import type { ProfileRecord, ProfileStore } from '../../lib/profile.js';
import type { Context } from '../context.js';

// trpc.ts validates the environment when it is imported. These tests run
// against an in-memory profile store — no database and no real secrets.
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.ARGON2_PEPPER ??= 'test-only-pepper-00000000000000000000000';
process.env.ACCESS_TOKEN_SECRET ??= 'test-only-access-token-secret-000000000';

const { createUsersRouter } = await import('./users.js');
const { createCallerFactory } = await import('../trpc.js');
const { __resetRateLimitsForTest } = await import('../../lib/rateLimit.js');

const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CAROL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BOB_AVATAR = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** A user row as Postgres holds it — including private columns no profile response may carry. */
type UserRow = ProfileRecord & { passwordHash: string; recoveryCodeHash: string; identitySigningPublicKey: Buffer | null };

const PRIVATE_FIELDS = ['passwordHash', 'recoveryCodeHash', 'identitySigningPublicKey'];

function seedRows(): UserRow[] {
  const secrets = { passwordHash: '$argon2id$synthetic', recoveryCodeHash: '$argon2id$synthetic', identitySigningPublicKey: null };
  return [
    { id: ALICE, username: 'alice', displayName: 'Alice', bio: null, birthday: null, birthdayVisibility: 'month_day', avatarId: null, ...secrets },
    {
      id: BOB,
      username: 'bob',
      displayName: 'Bob',
      bio: 'Coffee first.',
      birthday: '1988-07-03',
      birthdayVisibility: 'month_day',
      avatarId: BOB_AVATAR,
      ...secrets,
    },
    {
      id: CAROL,
      username: 'carol',
      displayName: 'Carol',
      bio: null,
      birthday: '1995-12-24',
      birthdayVisibility: 'hidden',
      avatarId: null,
      ...secrets,
    },
  ];
}

/**
 * Deliberately hands back whole rows, private columns included, so these
 * tests prove the router's projection — not the store's column list — is
 * what keeps private data out of responses.
 */
function createMemoryStore(rows: Map<string, UserRow>): ProfileStore {
  return {
    async findById(userId) {
      return rows.get(userId) ?? null;
    },
    async findByIds(userIds) {
      return userIds.flatMap((id) => rows.get(id) ?? []);
    },
    async update(userId, patch) {
      const row = rows.get(userId);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    },
    async setAvatar(userId, avatarId) {
      const row = rows.get(userId);
      if (!row) return null;
      const previousAvatarId = row.avatarId;
      row.avatarId = avatarId;
      return { previousAvatarId };
    },
  };
}

let rows = new Map<string, UserRow>();
const createCaller = createCallerFactory(createUsersRouter({ profiles: () => createMemoryStore(rows) }));

function callerFor(userId: string | null) {
  const ctx = {
    req: { ip: '127.0.0.1' },
    res: {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    db: {},
    user: userId ? { id: userId } : null,
    device: userId ? { id: `${userId}-device` } : null,
    // Session revocation has its own tests (sessions.test.ts); here every session is live.
    sessions: { isActive: async () => true, touch: () => {} },
  };
  return createCaller(ctx as unknown as Context);
}

function trpcError(code: TRPCError['code']) {
  return (err: unknown) => err instanceof TRPCError && err.code === code;
}

beforeEach(() => {
  __resetRateLimitsForTest();
  rows = new Map(seedRows().map((row) => [row.id, row]));
});

describe('users.updateProfile — bio', () => {
  test('saves a sanitized bio', async () => {
    const { user } = await callerFor(ALICE).updateProfile({ bio: '  Hello‮ there  ' });
    assert.equal(user.bio, 'Hello there');
    assert.equal(rows.get(ALICE)?.bio, 'Hello there');
  });

  test('clears the bio with an empty string or null', async () => {
    await callerFor(BOB).updateProfile({ bio: '   ' });
    assert.equal(rows.get(BOB)?.bio, null);
    await callerFor(BOB).updateProfile({ bio: 'Back again' });
    await callerFor(BOB).updateProfile({ bio: null });
    assert.equal(rows.get(BOB)?.bio, null);
  });

  test('rejects a bio over 160 characters without saving any field', async () => {
    await assert.rejects(callerFor(ALICE).updateProfile({ bio: 'x'.repeat(161), displayName: 'Changed' }), trpcError('BAD_REQUEST'));
    assert.equal(rows.get(ALICE)?.bio, null);
    assert.equal(rows.get(ALICE)?.displayName, 'Alice');
  });
});

describe('users.updateProfile — birthday', () => {
  test('saves a birthday as a calendar date together with its visibility', async () => {
    const { user } = await callerFor(ALICE).updateProfile({ birthday: '1992-02-29', birthdayVisibility: 'full' });
    assert.equal(user.birthday, '1992-02-29');
    assert.equal(user.birthdayVisibility, 'full');
    assert.equal(rows.get(ALICE)?.birthday, '1992-02-29');
  });

  test('rejects malformed, impossible, pre-1900 and future birthdays', async () => {
    const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const birthday of ['04/12/1990', '1990-02-30', '1899-06-01', future, '']) {
      await assert.rejects(callerFor(ALICE).updateProfile({ birthday }), trpcError('BAD_REQUEST'), birthday);
    }
    assert.equal(rows.get(ALICE)?.birthday, null);
  });

  test('clears the birthday with null', async () => {
    await callerFor(BOB).updateProfile({ birthday: null });
    assert.equal(rows.get(BOB)?.birthday, null);
  });

  test('rejects an unknown visibility value', async () => {
    await assert.rejects(callerFor(BOB).updateProfile({ birthdayVisibility: 'everyone' as never }), trpcError('BAD_REQUEST'));
    assert.equal(rows.get(BOB)?.birthdayVisibility, 'month_day');
  });
});

describe('users.updateProfile — compatibility and authorization', () => {
  test('still accepts the display-name-only payload older app versions send', async () => {
    const { user } = await callerFor(ALICE).updateProfile({ displayName: '  Alice A.  ' });
    assert.equal(user.id, ALICE);
    assert.equal(user.username, 'alice');
    assert.equal(user.displayName, 'Alice A.');
    for (const field of PRIVATE_FIELDS) assert.equal(field in user, false, field);
  });

  test('rejects an update with no fields', async () => {
    await assert.rejects(callerFor(ALICE).updateProfile({}), trpcError('BAD_REQUEST'));
  });

  test("only ever changes the caller's own profile", async () => {
    const bobBefore = { ...rows.get(BOB) };
    await callerFor(ALICE).updateProfile({ bio: 'Mine', userId: BOB, id: BOB } as never);
    assert.equal(rows.get(ALICE)?.bio, 'Mine');
    assert.deepEqual(rows.get(BOB), bobBefore);
  });
});

describe('users.getProfiles — viewing other users', () => {
  test("returns another user's public profile and nothing private", async () => {
    const { profiles } = await callerFor(ALICE).getProfiles({ userIds: [BOB] });
    assert.deepEqual(profiles, [
      {
        id: BOB,
        username: 'bob',
        displayName: 'Bob',
        bio: 'Coffee first.',
        avatarId: BOB_AVATAR,
        birthday: { month: 7, day: 3, year: null },
      },
    ]);
  });

  test("applies each owner's birthday visibility", async () => {
    const bob = rows.get(BOB);
    assert.ok(bob);
    bob.birthdayVisibility = 'full';
    const { profiles } = await callerFor(ALICE).getProfiles({ userIds: [BOB, CAROL] });
    assert.deepEqual(
      profiles.map((profile) => profile.birthday),
      [{ month: 7, day: 3, year: 1988 }, null],
    );
  });

  test('keeps request order and drops duplicates and unknown ids', async () => {
    const unknown = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const { profiles } = await callerFor(ALICE).getProfiles({ userIds: [CAROL, unknown, BOB, CAROL] });
    assert.deepEqual(
      profiles.map((profile) => profile.id),
      [CAROL, BOB],
    );
  });

  test('rejects malformed ids and oversized requests', async () => {
    await assert.rejects(callerFor(ALICE).getProfiles({ userIds: ['bob'] }), trpcError('BAD_REQUEST'));
    await assert.rejects(callerFor(ALICE).getProfiles({ userIds: [] }), trpcError('BAD_REQUEST'));
    await assert.rejects(callerFor(ALICE).getProfiles({ userIds: Array(51).fill(BOB) }), trpcError('BAD_REQUEST'));
  });
});

describe('users.me', () => {
  test('gives the owner their full birthday and visibility setting, and nothing private', async () => {
    const { profile } = await callerFor(CAROL).me();
    assert.equal(profile.birthday, '1995-12-24');
    assert.equal(profile.birthdayVisibility, 'hidden');
    for (const field of PRIVATE_FIELDS) assert.equal(field in profile, false, field);
  });
});

describe('profile authorization', () => {
  test('every profile procedure requires a signed-in user', async () => {
    const anonymous = callerFor(null);
    await assert.rejects(anonymous.me(), trpcError('UNAUTHORIZED'));
    await assert.rejects(anonymous.getProfiles({ userIds: [BOB] }), trpcError('UNAUTHORIZED'));
    await assert.rejects(anonymous.updateProfile({ bio: 'Hijacked' }), trpcError('UNAUTHORIZED'));
    assert.equal(rows.get(BOB)?.bio, 'Coffee first.');
  });
});
