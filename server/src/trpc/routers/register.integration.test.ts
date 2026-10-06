import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import { TRPCError } from '@trpc/server';

/**
 * Repeated sign-up requests against a real Postgres. Same opt-in as
 * e2ee.integration.test.ts: runs only with E2EE_TEST_DATABASE_URL pointing
 * at a DISPOSABLE database (tables are truncated).
 *
 * The bug: a sign-up whose response was lost (Android silently re-sends a
 * POST whose connection died; the app timing out) came back as "That
 * username is already taken" for the account just created — its recovery
 * code never shown.
 */
const url = process.env.E2EE_TEST_DATABASE_URL;

describe('repeated registration (Postgres)', { skip: url ? false : 'E2EE_TEST_DATABASE_URL not set' }, () => {
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

  const signUp = (overrides: Partial<{ username: string; password: string; registrationId: string }> = {}) =>
    caller().register({
      username: 'newcomer',
      displayName: 'Newcomer',
      password: 'Correct-Horse-Battery-9',
      device: { name: 'phone', platform: 'android' },
      ...overrides,
    });

  const conflict = (err: unknown) => err instanceof TRPCError && err.code === 'CONFLICT';

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

  beforeEach(async () => {
    m.rateLimit.__resetRateLimitsForTest();
    await m.db.pool.query('truncate users cascade');
  });

  test('the same sign-up sent twice creates one account and answers both with it', async () => {
    const registrationId = crypto.randomUUID();
    const first = await signUp({ registrationId });
    const again = await signUp({ registrationId });
    assert.equal(again.user.id, first.user.id);
    assert.deepEqual(again.recoveryCode, first.recoveryCode);
    const { rows } = await m.db.pool.query('select count(*)::int as n from users');
    assert.equal(rows[0].n, 1);
  });

  test('two copies arriving at once still create one account', async () => {
    const registrationId = crypto.randomUUID();
    const [a, b] = await Promise.all([signUp({ registrationId }), signUp({ registrationId })]);
    assert.equal(a.user.id, b.user.id);
    const { rows } = await m.db.pool.query('select count(*)::int as n from devices');
    assert.equal(rows[0].n, 1);
  });

  test('a repeat with the right id but another password is refused', async () => {
    const registrationId = crypto.randomUUID();
    await signUp({ registrationId });
    await assert.rejects(signUp({ registrationId, password: 'Some-Other-Password-1' }), conflict);
  });

  test('someone else picking a taken username is still refused', async () => {
    await signUp({ registrationId: crypto.randomUUID() });
    await assert.rejects(signUp({ registrationId: crypto.randomUUID() }), conflict);
    await assert.rejects(signUp(), conflict);
  });

  test('app versions that send no id behave as before', async () => {
    await signUp();
    await assert.rejects(signUp(), conflict);
  });
});
