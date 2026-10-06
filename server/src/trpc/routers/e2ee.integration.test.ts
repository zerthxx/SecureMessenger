import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import { TRPCError } from '@trpc/server';

/**
 * The group-generation protocol against a real Postgres: its guarantees
 * come from row locks and transactions, which only a real database can
 * show. Runs only when E2EE_TEST_DATABASE_URL points at a DISPOSABLE
 * database (every table is truncated between tests), e.g.
 *
 *   docker run -d -p 127.0.0.1:15432:5432 -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=sm_test postgres:16-alpine
 *   E2EE_TEST_DATABASE_URL=postgres://test:test@127.0.0.1:15432/sm_test npm test
 */
const url = process.env.E2EE_TEST_DATABASE_URL;

describe('e2ee group generations (Postgres)', { skip: url ? false : 'E2EE_TEST_DATABASE_URL not set' }, () => {
  if (!url) return;
  process.env.DATABASE_URL = url;
  process.env.ARGON2_PEPPER ??= 'test-only-pepper-00000000000000000000000';
  process.env.ACCESS_TOKEN_SECRET ??= 'test-only-access-token-secret-000000000';

  type Modules = {
    db: typeof import('../../db/client.js');
    router: typeof import('./e2ee.js');
    trpc: typeof import('../trpc.js');
    rateLimit: typeof import('../../lib/rateLimit.js');
  };
  let m: Modules;

  const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const MALLORY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const A1 = 'a0000000-0000-4000-8000-000000000001';
  const A2 = 'a0000000-0000-4000-8000-000000000002';
  const B1 = 'b0000000-0000-4000-8000-000000000001';
  const B_REVOKED = 'b0000000-0000-4000-8000-000000000002';
  const B_EXPIRED = 'b0000000-0000-4000-8000-000000000003';
  const B_NO_E2EE = 'b0000000-0000-4000-8000-000000000004';
  const M1 = 'c0000000-0000-4000-8000-000000000001';
  const WELCOME = Buffer.from('welcome-bytes').toString('base64');
  const CT = Buffer.from('ciphertext').toString('base64');
  /** A distinct ciphertext per call — identical ones are deduplicated as retries. */
  let ctCounter = 0;
  const ct = () => Buffer.from(`ciphertext-${++ctCounter}`).toString('base64');

  function as(userId: string, deviceId: string) {
    const ctx = {
      req: { ip: '203.0.113.9' },
      res: {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
      db: m.db.db,
      user: { id: userId },
      device: { id: deviceId },
      sessions: { isActive: async () => true, touch: () => {} },
    };
    return m.trpc.createCallerFactory(m.router.e2eeRouter)(ctx as never);
  }

  const trpcError = (code: TRPCError['code'], message?: string) => (err: unknown) =>
    err instanceof TRPCError && err.code === code && (message === undefined || err.message === message);

  before(async () => {
    m = {
      db: await import('../../db/client.js'),
      router: await import('./e2ee.js'),
      trpc: await import('../trpc.js'),
      rateLimit: await import('../../lib/rateLimit.js'),
    };
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await migrate(m.db.db, { migrationsFolder: 'src/db/migrations' });
  });

  after(async () => {
    await m.db.pool.end();
  });

  let conversationId: string;

  beforeEach(async () => {
    m.rateLimit.__resetRateLimitsForTest();
    const { pool } = m.db;
    await pool.query('truncate users, conversations cascade');
    const future = new Date(Date.now() + 30 * 86400000);
    const past = new Date(Date.now() - 86400000);
    await pool.query(
      `insert into users(id, username, display_name, password_hash, recovery_code_hash)
       values ($1,'alice','Alice','x','x'), ($2,'bob','Bob','x','x'), ($3,'mallory','Mallory','x','x')`,
      [ALICE, BOB, MALLORY],
    );
    const device = (id: string, user: string, opts: { revoked?: boolean; expires?: Date; key?: boolean } = {}) =>
      pool.query(
        `insert into devices(id, user_id, name, platform, refresh_token_expires_at, revoked_at, mls_credential_public_key)
         values ($1, $2, 'phone', 'android', $3, $4, $5)`,
        [id, user, opts.expires ?? future, opts.revoked ? new Date() : null, opts.key === false ? null : Buffer.from(`key-${id}`)],
      );
    await device(A1, ALICE);
    await device(A2, ALICE);
    await device(B1, BOB);
    await device(B_REVOKED, BOB, { revoked: true });
    await device(B_EXPIRED, BOB, { expires: past });
    await device(B_NO_E2EE, BOB, { key: false });
    await device(M1, MALLORY);
    ({ conversationId } = await as(ALICE, A1).createConversation({ otherUserId: BOB }));
  });

  test('the first group is generation 1 and its Welcome reaches only the addressed devices', async () => {
    const result = await as(ALICE, A1).resetGroup({ conversationId, expectedGeneration: 0, welcome: WELCOME, recipientDeviceIds: [B1, A2] });
    assert.deepEqual(result, { ok: true, generation: 1 });

    const [listed] = await as(BOB, B1).listConversations();
    assert.equal(listed?.groupGeneration, 1);

    const forB1 = await as(BOB, B1).fetchMessages({ conversationId });
    assert.deepEqual(
      forB1.map((row) => [row.messageType, row.mlsGeneration, row.senderUserId]),
      [['welcome', 1, ALICE]],
    );
    // Not addressed to A1 (the builder) or to any of Bob's other devices.
    assert.equal((await as(ALICE, A1).fetchMessages({ conversationId })).length, 0);
  });

  test('two devices setting up the same conversation at once: exactly one wins', async () => {
    const results = await Promise.all([
      as(ALICE, A1).resetGroup({ conversationId, expectedGeneration: 0, welcome: WELCOME, recipientDeviceIds: [B1] }),
      as(BOB, B1).resetGroup({ conversationId, expectedGeneration: 0, welcome: WELCOME, recipientDeviceIds: [A1] }),
      as(ALICE, A2).resetGroup({ conversationId, expectedGeneration: 0, welcome: WELCOME, recipientDeviceIds: [B1] }),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.deepEqual(
      results.filter((r) => !r.ok),
      [
        { ok: false, generation: 1, builtByThisDevice: false },
        { ok: false, generation: 1, builtByThisDevice: false },
      ],
    );
    const { rows } = await m.db.pool.query(`select count(*)::int as n from messages where message_type = 'welcome'`);
    assert.equal(rows[0].n, 1);
  });

  test('a message encrypted for a replaced group is refused so the sender can re-encrypt it', async () => {
    await as(ALICE, A1).resetGroup({ conversationId, expectedGeneration: 0, welcome: WELCOME, recipientDeviceIds: [B1] });
    await as(BOB, B1).sendMessage({ conversationId, ciphertext: ct(), messageType: 'application', mlsGeneration: 1 });
    await as(BOB, B1).resetGroup({ conversationId, expectedGeneration: 1, welcome: WELCOME, recipientDeviceIds: [A1] });

    await assert.rejects(
      as(ALICE, A1).sendMessage({ conversationId, ciphertext: ct(), messageType: 'application', mlsGeneration: 1 }),
      trpcError('CONFLICT', m.router.STALE_GROUP_GENERATION),
    );
    await as(ALICE, A1).sendMessage({ conversationId, ciphertext: ct(), messageType: 'application', mlsGeneration: 2 });
    // An app version from before generations can't write into a replaced group.
    await assert.rejects(
      as(ALICE, A1).sendMessage({ conversationId, ciphertext: ct(), messageType: 'application' }),
      trpcError('PRECONDITION_FAILED', m.router.UPDATE_REQUIRED),
    );

    const rows = (await as(BOB, B1).fetchMessages({ conversationId })).filter((r) => r.messageType === 'application');
    assert.deepEqual(
      rows.map((r) => [r.senderUserId, r.mlsGeneration]),
      [
        [BOB, 1],
        [ALICE, 2],
      ],
    );
  });

  test('the same send arriving twice is stored once and both calls get the original', async () => {
    await as(ALICE, A1).resetGroup({ conversationId, expectedGeneration: 0, welcome: WELCOME, recipientDeviceIds: [B1] });
    const send = { conversationId, ciphertext: CT, messageType: 'application' as const, mlsGeneration: 1 };
    const first = await as(ALICE, A1).sendMessage(send);
    const retried = await as(ALICE, A1).sendMessage(send);
    assert.deepEqual(retried, first);

    // Two identical requests racing each other.
    const other = { ...send, ciphertext: Buffer.from('another ciphertext').toString('base64') };
    const [x, y] = await Promise.all([as(ALICE, A1).sendMessage(other), as(ALICE, A1).sendMessage(other)]);
    assert.deepEqual(x, y);

    // A retry landing after the group changed still resolves to the original.
    await as(BOB, B1).resetGroup({ conversationId, expectedGeneration: 1, welcome: WELCOME, recipientDeviceIds: [A1] });
    assert.deepEqual(await as(ALICE, A1).sendMessage(send), first);

    const rows = (await as(BOB, B1).fetchMessages({ conversationId })).filter((r) => r.messageType === 'application');
    assert.equal(rows.length, 2);
    // Welcomes are exempt: one Welcome is legitimately stored once per recipient.
    const { rows: welcomes } = await m.db.pool.query(`select count(*)::int as n from messages where message_type = 'welcome'`);
    assert.equal(welcomes[0].n, 2);
  });

  test('older app versions keep working in a conversation still on its first group', async () => {
    await as(ALICE, A1).resetGroup({ conversationId, expectedGeneration: 0, welcome: WELCOME, recipientDeviceIds: [B1] });
    await as(ALICE, A1).sendMessage({ conversationId, ciphertext: CT, messageType: 'application' });
    const [row] = (await as(BOB, B1).fetchMessages({ conversationId })).filter((r) => r.messageType === 'application');
    assert.equal(row?.mlsGeneration, 1, 'rows without a generation read as generation 1');
  });

  test('a builder whose response was lost can tell its own rebuild went through', async () => {
    const first = await as(ALICE, A1).resetGroup({ conversationId, expectedGeneration: 0, welcome: WELCOME, recipientDeviceIds: [B1] });
    assert.deepEqual(first, { ok: true, generation: 1 });
    // The retry of the "lost" call, and the same call from someone else.
    assert.deepEqual(await as(ALICE, A1).resetGroup({ conversationId, expectedGeneration: 0, welcome: WELCOME, recipientDeviceIds: [B1] }), {
      ok: false,
      generation: 1,
      builtByThisDevice: true,
    });
    assert.deepEqual(await as(BOB, B1).resetGroup({ conversationId, expectedGeneration: 0, welcome: WELCOME, recipientDeviceIds: [A1] }), {
      ok: false,
      generation: 1,
      builtByThisDevice: false,
    });
  });

  test('createConversation reports the current generation for an existing conversation', async () => {
    assert.deepEqual(await as(BOB, B1).createConversation({ otherUserId: ALICE }), { conversationId, groupGeneration: 0 });
    await as(ALICE, A1).resetGroup({ conversationId, expectedGeneration: 0, welcome: WELCOME, recipientDeviceIds: [B1] });
    assert.deepEqual(await as(BOB, B1).createConversation({ otherUserId: ALICE }), { conversationId, groupGeneration: 1 });
  });

  test('sends racing a group change are either stored in the old generation or refused, never lost', async () => {
    await as(ALICE, A1).resetGroup({ conversationId, expectedGeneration: 0, welcome: WELCOME, recipientDeviceIds: [B1] });
    const sends = Array.from({ length: 25 }, () =>
      as(ALICE, A1)
        .sendMessage({ conversationId, ciphertext: ct(), messageType: 'application', mlsGeneration: 1 })
        .then(
          () => 'sent' as const,
          (err: unknown) => {
            if (trpcError('CONFLICT', m.router.STALE_GROUP_GENERATION)(err)) return 'stale' as const;
            throw err;
          },
        ),
    );
    const reset = as(BOB, B1).resetGroup({ conversationId, expectedGeneration: 1, welcome: WELCOME, recipientDeviceIds: [A1] });
    const outcomes = await Promise.all(sends);
    assert.deepEqual(await reset, { ok: true, generation: 2 });

    const { rows } = await m.db.pool.query(
      `select count(*)::int as n from messages where message_type = 'application' and mls_generation = 1`,
    );
    assert.equal(rows[0].n, outcomes.filter((o) => o === 'sent').length, 'every accepted send is stored, as generation 1');
    const { rows: wrong } = await m.db.pool.query(
      `select count(*)::int as n from messages where message_type = 'application' and mls_generation <> 1`,
    );
    assert.equal(wrong[0].n, 0);
  });

  test('group setup only addresses active, E2EE-ready devices of the members', async () => {
    const alice = as(ALICE, A1);
    for (const bad of [B_REVOKED, B_EXPIRED, B_NO_E2EE, M1]) {
      await assert.rejects(
        alice.resetGroup({ conversationId, expectedGeneration: 0, welcome: WELCOME, recipientDeviceIds: [B1, bad] }),
        trpcError('BAD_REQUEST'),
        `recipient ${bad} must be refused`,
      );
    }
    await assert.rejects(
      alice.resetGroup({ conversationId, expectedGeneration: 0, welcome: WELCOME, recipientDeviceIds: [A1] }),
      trpcError('BAD_REQUEST'),
    );
    await assert.rejects(
      as(MALLORY, M1).resetGroup({ conversationId, expectedGeneration: 0, welcome: WELCOME, recipientDeviceIds: [B1] }),
      trpcError('FORBIDDEN'),
    );
    const [listed] = await as(ALICE, A1).listConversations();
    assert.equal(listed?.groupGeneration, 0, 'a refused setup changes nothing');
  });

  test('a signed-out device cannot set up or change the group', async () => {
    await assert.rejects(
      as(BOB, B_REVOKED).resetGroup({ conversationId, expectedGeneration: 0, welcome: WELCOME, recipientDeviceIds: [A1] }),
      trpcError('UNAUTHORIZED'),
    );
  });

  test('conversation devices are exactly the active, E2EE-ready devices of its members', async () => {
    const devices = await as(ALICE, A1).listConversationDevices({ conversationId });
    assert.deepEqual(devices.map((d) => d.deviceId).sort(), [A1, A2, B1].sort());
    assert.equal(devices.find((d) => d.deviceId === B1)?.credentialPublicKey, Buffer.from(`key-${B1}`).toString('base64'));
    assert.deepEqual((await as(ALICE, A1).listActiveDeviceIds({ userId: BOB })).sort(), [B1]);
    await assert.rejects(as(MALLORY, M1).listConversationDevices({ conversationId }), trpcError('FORBIDDEN'));
  });

  test('expired KeyPackages are never handed out, stop counting, and get cleaned up', async () => {
    const { pool } = m.db;
    const old = new Date(Date.now() - m.router.KEY_PACKAGE_MAX_AGE_MS - 86400000);
    await pool.query(`insert into device_key_packages(device_id, public_key_package, created_at) values ($1, $2, $3), ($1, $2, $3)`, [
      B1,
      Buffer.from('stale'),
      old,
    ]);
    assert.deepEqual(await as(BOB, B1).keyPackageStatus(), { available: 0 });
    assert.deepEqual(await as(ALICE, A1).consumeKeyPackage({ targetDeviceId: B1 }), { keyPackage: null });

    await as(BOB, B1).publishKeyPackages({ keyPackages: [Buffer.from('fresh').toString('base64')] });
    assert.deepEqual(await as(BOB, B1).keyPackageStatus(), { available: 1 });
    assert.deepEqual(await as(ALICE, A1).consumeKeyPackage({ targetDeviceId: B1 }), { keyPackage: Buffer.from('fresh').toString('base64') });
    const { rows } = await pool.query(`select count(*)::int as n from device_key_packages where device_id = $1`, [B1]);
    assert.equal(rows[0].n, 0);
  });

  test('a device whose session expired without signing out gets no KeyPackages consumed', async () => {
    await m.db.pool.query(`insert into device_key_packages(device_id, public_key_package) values ($1, $2)`, [B_EXPIRED, Buffer.from('kp')]);
    assert.deepEqual(await as(ALICE, A1).consumeKeyPackage({ targetDeviceId: B_EXPIRED }), { keyPackage: null });
  });

  test('a Welcome claiming a generation is refused — generations only come from resetGroup', async () => {
    await as(ALICE, A1).resetGroup({ conversationId, expectedGeneration: 0, welcome: WELCOME, recipientDeviceIds: [B1] });
    // Bob tries to plant a Welcome for the current generation (or a newer
    // one) that Alice's other device would join instead of the real one.
    for (const mlsGeneration of [1, 2, 99]) {
      await assert.rejects(
        as(BOB, B1).sendMessage({ conversationId, ciphertext: ct(), messageType: 'welcome', recipientDeviceId: A2, mlsGeneration }),
        trpcError('BAD_REQUEST'),
      );
    }
    const forA2 = await as(ALICE, A2).fetchMessages({ conversationId });
    assert.equal(forA2.filter((r) => r.messageType === 'welcome').length, 0);
  });

  test('older app versions can still send their Welcome while the conversation is on its first group', async () => {
    await as(ALICE, A1).sendMessage({ conversationId, ciphertext: ct(), messageType: 'welcome', recipientDeviceId: B1 });
    const [welcome] = (await as(BOB, B1).fetchMessages({ conversationId })).filter((r) => r.messageType === 'welcome');
    assert.equal(welcome?.mlsGeneration, 1, 'stored without a generation, so it can never pass for a newer one');
  });

  test('a legacy Welcome is refused once the conversation has moved past its first group', async () => {
    await as(ALICE, A1).resetGroup({ conversationId, expectedGeneration: 0, welcome: WELCOME, recipientDeviceIds: [B1] });
    await as(BOB, B1).resetGroup({ conversationId, expectedGeneration: 1, welcome: WELCOME, recipientDeviceIds: [A1] });
    await assert.rejects(
      as(ALICE, A1).sendMessage({ conversationId, ciphertext: ct(), messageType: 'welcome', recipientDeviceId: B1 }),
      trpcError('PRECONDITION_FAILED'),
    );
  });

  test("a Welcome is only for an active device of a member, and an application message isn't addressed at all", async () => {
    for (const recipientDeviceId of [M1, B_REVOKED, B_NO_E2EE]) {
      await assert.rejects(
        as(ALICE, A1).sendMessage({ conversationId, ciphertext: ct(), messageType: 'welcome', recipientDeviceId }),
        trpcError('BAD_REQUEST'),
      );
    }
    await assert.rejects(
      as(ALICE, A1).sendMessage({ conversationId, ciphertext: ct(), messageType: 'application', recipientDeviceId: B1 }),
      trpcError('BAD_REQUEST'),
    );
  });

  test("only devices one could add to a group can have their KeyPackages consumed: one's own, or a conversation partner's", async () => {
    const kp = (device: string, n: number) =>
      m.db.pool.query(`insert into device_key_packages(device_id, public_key_package) select $1, convert_to('kp-' || g, 'UTF8') from generate_series(1, $2) g`, [device, n]);
    await kp(B1, 3);
    await kp(A2, 1);
    // Mallory shares no conversation with Bob: she can't drain his device.
    assert.deepEqual(await as(MALLORY, M1).consumeKeyPackage({ targetDeviceId: B1 }), { keyPackage: null });
    // Alice can (they share a conversation), and so can Alice for her own other device.
    assert.notEqual((await as(ALICE, A1).consumeKeyPackage({ targetDeviceId: B1 })).keyPackage, null);
    assert.notEqual((await as(ALICE, A1).consumeKeyPackage({ targetDeviceId: A2 })).keyPackage, null);
    const { rows } = await m.db.pool.query(`select count(*)::int as n from device_key_packages where device_id = $1`, [B1]);
    assert.equal(rows[0].n, 2, "Mallory's attempt used none of Bob's");
  });

  test("a user's device list is only for that user and their conversation partners", async () => {
    assert.deepEqual(await as(MALLORY, M1).listActiveDeviceIds({ userId: BOB }), []);
    assert.ok((await as(ALICE, A1).listActiveDeviceIds({ userId: BOB })).includes(B1));
    assert.ok((await as(BOB, B1).listActiveDeviceIds({ userId: BOB })).includes(B1));
  });
});
