import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

/**
 * fetchMessages paging against a real Postgres. Same opt-in as
 * e2ee.integration.test.ts: runs only with E2EE_TEST_DATABASE_URL pointing
 * at a DISPOSABLE database (tables are truncated).
 *
 * The problem: fetchMessages had no limit, so a device's first sync of a
 * long conversation read, encoded and sent its whole history in one call.
 */
const url = process.env.E2EE_TEST_DATABASE_URL;

describe('fetchMessages paging (Postgres)', { skip: url ? false : 'E2EE_TEST_DATABASE_URL not set' }, () => {
  if (!url) return;
  process.env.DATABASE_URL = url;
  process.env.ARGON2_PEPPER ??= 'test-only-pepper-00000000000000000000000';
  process.env.ACCESS_TOKEN_SECRET ??= 'test-only-access-token-secret-000000000';

  let m: {
    db: typeof import('../../db/client.js');
    router: typeof import('./e2ee.js');
    trpc: typeof import('../trpc.js');
    rateLimit: typeof import('../../lib/rateLimit.js');
  };

  const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const A1 = 'a0000000-0000-4000-8000-000000000001';
  const B1 = 'b0000000-0000-4000-8000-000000000001';
  const B2 = 'b0000000-0000-4000-8000-000000000002';
  const CONVERSATION = 'c1000000-0000-4000-8000-000000000001';

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

  /**
   * `count` application messages from Alice. Every `sameInstantEvery` rows
   * share one microsecond-exact timestamp, so page boundaries fall inside
   * groups of equal timestamps.
   */
  async function insertMessages(count: number, opts: { start?: Date; sameInstantEvery?: number } = {}) {
    await m.db.pool.query(
      `insert into messages (conversation_id, sender_device_id, message_type, ciphertext, mls_generation, created_at)
       select $1, $2, 'application', convert_to('ct-' || g, 'UTF8'), 1,
              $3::timestamptz + (g / $4) * interval '1 millisecond'
       from generate_series(1, $5) as g`,
      [CONVERSATION, A1, (opts.start ?? new Date('2026-01-01T00:00:00Z')).toISOString(), opts.sameInstantEvery ?? 1, count],
    );
  }

  async function expectedOrder(): Promise<string[]> {
    const { rows } = await m.db.pool.query<{ id: string }>(
      `select id from messages where conversation_id = $1 and recipient_device_id is null order by created_at, id`,
      [CONVERSATION],
    );
    return rows.map((r) => r.id);
  }

  /** Walks every page the way the app does, returning the in-page rows in order. */
  async function walk(deviceUser: [string, string], limit: number, sinceCreatedAt?: string) {
    const seen: { id: string; messageType: string }[] = [];
    let afterCursor: string | undefined;
    let calls = 0;
    for (;;) {
      calls++;
      const page = await as(...deviceUser).fetchMessages({
        conversationId: CONVERSATION,
        ...(sinceCreatedAt ? { sinceCreatedAt } : {}),
        page: { limit, ...(afterCursor ? { after: afterCursor } : {}) },
      });
      const inPage = page.filter((row) => !('outOfPage' in row && row.outOfPage));
      assert.ok(inPage.length <= limit);
      seen.push(...inPage);
      if (inPage.length < limit) return { seen, calls };
      afterCursor = inPage[inPage.length - 1]!.cursor;
    }
  }

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

  beforeEach(async () => {
    m.rateLimit.__resetRateLimitsForTest();
    const { pool } = m.db;
    await pool.query('truncate users, conversations cascade');
    await pool.query(
      `insert into users(id, username, display_name, password_hash, recovery_code_hash)
       values ($1,'alice','Alice','x','x'), ($2,'bob','Bob','x','x')`,
      [ALICE, BOB],
    );
    for (const [id, user] of [
      [A1, ALICE],
      [B1, BOB],
      [B2, BOB],
    ]) {
      await pool.query(
        `insert into devices(id, user_id, name, platform, refresh_token_expires_at, mls_credential_public_key)
         values ($1, $2, 'phone', 'android', now() + interval '30 days', $3)`,
        [id, user, Buffer.from(`key-${id}`)],
      );
    }
    await pool.query(`insert into conversations(id, type, mls_generation) values ($1, 'direct', 1)`, [CONVERSATION]);
    await pool.query(`insert into conversation_members(conversation_id, user_id) values ($1, $2), ($1, $3)`, [CONVERSATION, ALICE, BOB]);
  });

  test('a short conversation comes in one page', async () => {
    await insertMessages(5);
    const { seen, calls } = await walk([BOB, B1], 200);
    assert.equal(calls, 1);
    assert.deepEqual(
      seen.map((r) => r.id),
      await expectedOrder(),
    );
  });

  test('a medium conversation is walked page by page, every message exactly once and in order', async () => {
    await insertMessages(1200, { sameInstantEvery: 7 });
    const { seen, calls } = await walk([BOB, B1], 500);
    assert.equal(calls, 3);
    const ids = seen.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, 'no message twice');
    assert.deepEqual(ids, await expectedOrder());
  });

  test('a very long conversation with many identical timestamps: nothing skipped or repeated', async () => {
    // 50 rows per millisecond, and the cursor is microsecond-exact: page
    // boundaries land inside runs of equal timestamps.
    await insertMessages(12_000, { sameInstantEvery: 50 });
    const started = Date.now();
    const { seen, calls } = await walk([BOB, B1], 500);
    const ids = seen.map((r) => r.id);
    assert.equal(calls, 25);
    assert.equal(new Set(ids).size, 12_000);
    assert.deepEqual(ids, await expectedOrder());
    assert.ok(Date.now() - started < 20_000, `walk took ${Date.now() - started} ms`);
  });

  test('older app versions (no paging) get at most LEGACY_MAX_ROWS, the oldest first', async () => {
    await insertMessages(m.router.LEGACY_MAX_ROWS + 300);
    const rows = await as(BOB, B1).fetchMessages({ conversationId: CONVERSATION });
    assert.equal(rows.length, m.router.LEGACY_MAX_ROWS);
    assert.deepEqual(
      rows.map((r) => r.id),
      (await expectedOrder()).slice(0, m.router.LEGACY_MAX_ROWS),
    );
    assert.ok(rows.every((r) => !('outOfPage' in r)));
  });

  test("a full page brings along this device's later Welcomes (only its own), marked out of page", async () => {
    await insertMessages(30);
    const later = new Date('2026-02-01T00:00:00Z');
    await m.db.pool.query(
      `insert into messages (conversation_id, sender_device_id, recipient_device_id, message_type, ciphertext, mls_generation, created_at)
       values ($1, $2, $3, 'welcome', 'w-b1', 2, $5), ($1, $2, $4, 'welcome', 'w-b2', 2, $5)`,
      [CONVERSATION, A1, B1, B2, later.toISOString()],
    );
    const page = await as(BOB, B1).fetchMessages({ conversationId: CONVERSATION, page: { limit: 10 } });
    const outOfPage = page.filter((r) => 'outOfPage' in r && r.outOfPage);
    assert.equal(page.length - outOfPage.length, 10);
    assert.equal(outOfPage.length, 1);
    assert.equal(outOfPage[0]!.messageType, 'welcome');
    assert.equal(outOfPage[0]!.mlsGeneration, 2);

    // Walking on, the Welcome also arrives in its own place — exactly once
    // per response, never both in-page and out of page.
    const { seen } = await walk([BOB, B1], 10);
    assert.equal(seen.filter((r) => r.messageType === 'welcome').length, 1);
  });

  test('a page that is not full brings nothing extra', async () => {
    await insertMessages(3);
    await m.db.pool.query(
      `insert into messages (conversation_id, sender_device_id, recipient_device_id, message_type, ciphertext, mls_generation)
       values ($1, $2, $3, 'welcome', 'w', 2)`,
      [CONVERSATION, A1, B1],
    );
    const page = await as(BOB, B1).fetchMessages({ conversationId: CONVERSATION, page: { limit: 10 } });
    assert.equal(page.length, 4);
    assert.ok(page.every((r) => !('outOfPage' in r)));
  });

  test('incremental sync with paging returns exactly the rows since the cursor, in order', async () => {
    await insertMessages(1000, { sameInstantEvery: 3 });
    const all = await expectedOrder();
    const { rows } = await m.db.pool.query<{ created_at: Date }>(`select created_at from messages where id = $1`, [all[600]]);
    const since = rows[0]!.created_at.toISOString();
    const { seen } = await walk([BOB, B1], 128, since);
    const { rows: expected } = await m.db.pool.query<{ id: string }>(
      `select id from messages where conversation_id = $1 and created_at >= $2 order by created_at, id`,
      [CONVERSATION, since],
    );
    assert.deepEqual(
      seen.map((r) => r.id),
      expected.map((r) => r.id),
    );
  });

  test('a malformed page cursor is rejected', async () => {
    await assert.rejects(as(BOB, B1).fetchMessages({ conversationId: CONVERSATION, page: { limit: 10, after: "x' or 1=1 --" } }));
    await assert.rejects(as(BOB, B1).fetchMessages({ conversationId: CONVERSATION, page: { limit: 10_000 } }));
  });
});
