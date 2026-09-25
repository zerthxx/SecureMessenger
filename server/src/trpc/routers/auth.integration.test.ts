import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import { TRPCError } from '@trpc/server';

/**
 * Refresh-token rotation against a real Postgres. Same opt-in as
 * e2ee.integration.test.ts: runs only with E2EE_TEST_DATABASE_URL pointing
 * at a DISPOSABLE database (tables are truncated).
 *
 * The bug: every refresh replaced the token outright, so an app that never
 * received a refresh response (dropped connection, killed mid-launch) was
 * signed out on its next launch as if its session had been ended.
 */
const url = process.env.E2EE_TEST_DATABASE_URL;

describe('refresh token rotation (Postgres)', { skip: url ? false : 'E2EE_TEST_DATABASE_URL not set' }, () => {
  if (!url) return;
  process.env.DATABASE_URL = url;
  process.env.ARGON2_PEPPER ??= 'test-only-pepper-00000000000000000000000';
  process.env.ACCESS_TOKEN_SECRET ??= 'test-only-access-token-secret-000000000';

  let m: {
    db: typeof import('../../db/client.js');
    auth: typeof import('./auth.js');
    trpc: typeof import('../trpc.js');
    rateLimit: typeof import('../../lib/rateLimit.js');
    sessions: typeof import('../../lib/sessions.js');
    store: typeof import('../../lib/sessionStore.js');
  };

  function caller() {
    const sessions = new m.sessions.SessionManager(m.store.createDbSessionStore(m.db.db), {
      isOnline: () => false,
      onEnded: () => {},
    } as never);
    const ctx = {
      req: { ip: '203.0.113.9' },
      res: {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
      db: m.db.db,
      user: null,
      device: null,
      sessions,
    };
    return m.trpc.createCallerFactory(m.auth.authRouter)(ctx as never);
  }

  const unauthorized = (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED';

  before(async () => {
    m = {
      db: await import('../../db/client.js'),
      auth: await import('./auth.js'),
      trpc: await import('../trpc.js'),
      rateLimit: await import('../../lib/rateLimit.js'),
      sessions: await import('../../lib/sessions.js'),
      store: await import('../../lib/sessionStore.js'),
    };
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await migrate(m.db.db, { migrationsFolder: 'src/db/migrations' });
  });

  after(async () => {
    await m.db.pool.end();
  });

  let first: string;
  let deviceId: string;

  beforeEach(async () => {
    m.rateLimit.__resetRateLimitsForTest();
    await m.db.pool.query('truncate users cascade');
    const registered = await caller().register({
      username: 'rotation',
      displayName: 'Rotation',
      password: 'Correct-Horse-Battery-9',
      device: { name: 'phone', platform: 'android' },
    });
    first = registered.session.refreshToken;
    deviceId = registered.device.id;
  });

  test('a replaced token still works during the grace period (the response was lost)', async () => {
    const lost = await caller().refresh({ refreshToken: first });
    // The app never saw `lost` and presents the old token again.
    const recovered = await caller().refresh({ refreshToken: first });
    assert.notEqual(recovered.session.refreshToken, lost.session.refreshToken);
    // And carries on normally with what it did receive.
    await caller().refresh({ refreshToken: recovered.session.refreshToken });
  });

  test('a replaced token stops working once the grace period is over', async () => {
    await caller().refresh({ refreshToken: first });
    await m.db.pool.query(`update devices set previous_refresh_token_valid_until = now() - interval '1 second' where id = $1`, [deviceId]);
    await assert.rejects(caller().refresh({ refreshToken: first }), unauthorized);
  });

  test('using an old token again does not extend its grace period', async () => {
    await caller().refresh({ refreshToken: first });
    const { rows: before } = await m.db.pool.query(`select previous_refresh_token_valid_until v from devices where id = $1`, [deviceId]);
    await caller().refresh({ refreshToken: first });
    const { rows: after } = await m.db.pool.query(`select previous_refresh_token_valid_until v from devices where id = $1`, [deviceId]);
    assert.equal(after[0].v.getTime(), before[0].v.getTime());
  });

  test('tokens older than the one just replaced never work', async () => {
    const second = (await caller().refresh({ refreshToken: first })).session.refreshToken;
    await caller().refresh({ refreshToken: second });
    await assert.rejects(caller().refresh({ refreshToken: first }), unauthorized);
  });

  test('signing out ends both the current and the replaced token', async () => {
    const second = (await caller().refresh({ refreshToken: first })).session.refreshToken;
    await m.db.pool.query(`update devices set revoked_at = now() where id = $1`, [deviceId]);
    await assert.rejects(caller().refresh({ refreshToken: first }), unauthorized);
    await assert.rejects(caller().refresh({ refreshToken: second }), unauthorized);
  });
});
