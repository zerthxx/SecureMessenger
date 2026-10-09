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
  /** Signed in, E2EE-ready, but silent for longer than ADDRESSABLE_IDLE_MS: a wiped or abandoned phone. */
  const B_STALE = 'b0000000-0000-4000-8000-000000000005';
  const M1 = 'c0000000-0000-4000-8000-000000000001';
  const WELCOME = Buffer.from('welcome-bytes').toString('base64');
  const CT = Buffer.from('ciphertext').toString('base64');
  /** A distinct ciphertext per call — identical ones are deduplicated as retries. */
  let ctCounter = 0;
  const ct = () => Buffer.from(`ciphertext-${++ctCounter}`).toString('base64');

  /** Response headers the last call set (Retry-After under load shedding). */
  const responseHeaders: Record<string, string> = {};

  function as(userId: string, deviceId: string) {
    const ctx = {
      req: { ip: '203.0.113.9' },
      res: {
        header: (name: string, value: string) => {
          responseHeaders[name] = value;
        },
      },
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
    const device = (id: string, user: string, opts: { revoked?: boolean; expires?: Date; key?: boolean; seen?: Date } = {}) =>
      pool.query(
        `insert into devices(id, user_id, name, platform, refresh_token_expires_at, revoked_at, mls_credential_public_key, last_seen_at)
         values ($1, $2, 'phone', 'android', $3, $4, $5, $6)`,
        [
          id,
          user,
          opts.expires ?? future,
          opts.revoked ? new Date() : null,
          opts.key === false ? null : Buffer.from(`key-${id}`),
          opts.seen ?? new Date(),
        ],
      );
    await device(A1, ALICE);
    await device(A2, ALICE);
    await device(B1, BOB);
    await device(B_REVOKED, BOB, { revoked: true });
    await device(B_EXPIRED, BOB, { expires: past });
    await device(B_NO_E2EE, BOB, { key: false });
    await device(B_STALE, BOB, { seen: new Date(Date.now() - m.router.ADDRESSABLE_IDLE_MS - 60_000) });
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

  test('the conversation list tells each device whether it built the current group', async () => {
    // Before any group: nobody built generation 0.
    assert.equal((await as(ALICE, A1).listConversations())[0]?.groupBuiltByThisDevice, false);

    await as(ALICE, A1).resetGroup({ conversationId, expectedGeneration: 0, welcome: WELCOME, recipientDeviceIds: [B1, A2] });
    // The builder — even after it gave up waiting for the answer or was
    // killed — can recognise its own group; nobody else can claim it, not
    // even another device of the same account.
    assert.equal((await as(ALICE, A1).listConversations())[0]?.groupBuiltByThisDevice, true);
    assert.equal((await as(ALICE, A2).listConversations())[0]?.groupBuiltByThisDevice, false);
    assert.equal((await as(BOB, B1).listConversations())[0]?.groupBuiltByThisDevice, false);

    // Once someone else rebuilds, the earlier builder no longer owns the current group.
    await as(BOB, B1).resetGroup({ conversationId, expectedGeneration: 1, welcome: WELCOME, recipientDeviceIds: [A1] });
    const [forAlice] = await as(ALICE, A1).listConversations();
    assert.deepEqual({ generation: forAlice?.groupGeneration, mine: forAlice?.groupBuiltByThisDevice }, { generation: 2, mine: false });
    assert.equal((await as(BOB, B1).listConversations())[0]?.groupBuiltByThisDevice, true);
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
    for (const bad of [B_REVOKED, B_EXPIRED, B_NO_E2EE, B_STALE, M1]) {
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
    // A phone that was wiped or abandoned without signing out: silent past
    // ADDRESSABLE_IDLE_MS, so its KeyPackages are not handed out either.
    await as(BOB, B_STALE).publishKeyPackages({ keyPackages: [Buffer.from('stale').toString('base64')] });
    assert.deepEqual(await as(ALICE, A1).consumeKeyPackage({ targetDeviceId: B_STALE }), { keyPackage: null });
    assert.equal((await as(ALICE, A1).listConversationDevices({ conversationId })).some((d) => d.deviceId === B_STALE), false);
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

  // sendMessage folds its two authorization checks into one statement (the
  // database is far from the API in production); each must still refuse.
  test('only an active device of a member can send', async () => {
    const { rows: before } = await m.db.pool.query(`select count(*)::int as n from messages`);
    await assert.rejects(
      as(MALLORY, M1).sendMessage({ conversationId, ciphertext: ct(), messageType: 'application', mlsGeneration: 1 }),
      trpcError('FORBIDDEN'),
    );
    await assert.rejects(
      as(BOB, B_REVOKED).sendMessage({ conversationId, ciphertext: ct(), messageType: 'application', mlsGeneration: 1 }),
      trpcError('UNAUTHORIZED'),
    );
    // A device that no longer exists at all is refused the same way.
    await assert.rejects(
      as(BOB, 'b0000000-0000-4000-8000-0000000000ff').sendMessage({ conversationId, ciphertext: ct(), messageType: 'application', mlsGeneration: 1 }),
      trpcError('UNAUTHORIZED'),
    );
    const { rows: after } = await m.db.pool.query(`select count(*)::int as n from messages`);
    assert.equal(after[0].n, before[0].n, 'nothing was stored');
  });

  // Found by the scale mission's outage test: pg's Pool emits 'error' for an
  // idle client whose backend goes away (database restart, pause, network
  // blip). Unhandled, that event took the whole process down, which turned a
  // database blip into an API outage with every socket dropped.
  test('losing the idle database connections does not kill the process, and the pool recovers', async () => {
    // Warm a few idle connections, then have the database close every
    // backend except the one running this statement.
    await Promise.all([1, 2, 3].map(() => m.db.pool.query('select pg_sleep(0.05)')));
    assert.ok(m.db.pool.idleCount >= 1, 'the pool holds idle connections');
    await m.db.pool.query(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()`,
    );
    // Give the closed sockets a moment to surface as pool 'error' events.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const { rows } = await m.db.pool.query('select 1 as ok');
    assert.equal(rows[0].ok, 1, 'the pool serves queries again on fresh connections');
  });

  /** Holds every pooled connection busy and queues `extra` more requests behind them. */
  function saturatePool(extra: number, seconds = 0.4) {
    const max = m.db.poolStats().max;
    const busy = Promise.all(Array.from({ length: max + extra }, () => m.db.pool.query('select pg_sleep($1)', [seconds])));
    busy.catch(() => {});
    return busy;
  }

  test('pool exhaustion is visible as a wait queue and drains by itself', async () => {
    const busy = saturatePool(5);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const during = m.db.poolStats();
    assert.equal(during.total, during.max, 'every connection is open');
    assert.equal(during.idle, 0);
    assert.ok(during.waiting >= 1, `requests queue once the pool is full (waiting=${during.waiting})`);
    await busy;
    const after = m.db.poolStats();
    assert.equal(after.waiting, 0, 'the queue drains once the work finishes');
  });

  test('under pool overload, polling is shed with Retry-After while a send still goes through and is stored once', async () => {
    const { shedWaitingThreshold } = await import('../../config/env.js');
    assert.ok(shedWaitingThreshold > 0, 'shedding is on by default');
    await as(ALICE, A1).resetGroup({ conversationId, expectedGeneration: 0, welcome: WELCOME, recipientDeviceIds: [B1] });
    // Queue deeper than the threshold, then poll and send concurrently.
    const busy = saturatePool(shedWaitingThreshold + 5, 0.6);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(m.db.poolStats().waiting > shedWaitingThreshold, 'the queue is past the threshold');
    delete responseHeaders['Retry-After'];
    await assert.rejects(as(ALICE, A1).listConversations(), trpcError('TOO_MANY_REQUESTS'));
    await assert.rejects(as(ALICE, A1).fetchMessages({ conversationId }), trpcError('TOO_MANY_REQUESTS'));
    const retryAfter = Number(responseHeaders['Retry-After']);
    assert.ok(retryAfter >= 5 && retryAfter <= 30, `Retry-After is set (${responseHeaders['Retry-After']})`);
    // The send is not shed: it queues behind the busy connections and lands exactly once.
    const generation = (await (async () => {
      const { rows } = await m.db.pool.query(`select mls_generation from conversations where id = $1`, [conversationId]);
      return rows[0].mls_generation as number;
    })());
    const ciphertext = ct();
    const sent = await as(ALICE, A1).sendMessage({ conversationId, ciphertext, messageType: 'application', mlsGeneration: generation });
    await busy;
    const { rows } = await m.db.pool.query(`select count(*)::int as n from messages where id = $1`, [sent.messageId]);
    assert.equal(rows[0].n, 1);
    // Recovery: once the queue drains, polling works again without any restart.
    assert.equal(m.db.poolStats().waiting, 0);
    assert.ok(Array.isArray(await as(ALICE, A1).listConversations()));
  });

  test('/health/db reports reachability and pool counts and nothing else', async () => {
    const { buildApp } = await import('../../app.js');
    const app = buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/health/db' });
      assert.equal(res.statusCode, 200);
      const body = res.json() as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), ['database', 'latencyMs', 'pool', 'status']);
      assert.equal(body.status, 'ok');
      assert.equal(body.database, 'reachable');
      assert.equal(typeof body.latencyMs, 'number');
      assert.deepEqual(Object.keys(body.pool as object).sort(), ['idle', 'max', 'total', 'waiting']);
      for (const value of Object.values(body.pool as Record<string, unknown>)) assert.equal(typeof value, 'number');
      assert.ok(!JSON.stringify(body).includes('postgres://'), 'no connection string in the response');
    } finally {
      await app.close();
    }
  });
});
