import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MAX_PENDING_REVOCATIONS, revokeAll, revokeSession, type EndedSession, type RevocationDeps } from './sessionRevocation.ts';

const session: EndedSession = { accessToken: 'at-1', refreshToken: 'rt-1' };

function deps(script: { logout: (number | null)[]; refresh?: (EndedSession | 'ended' | null)[] }) {
  const calls: string[] = [];
  const d: RevocationDeps = {
    logout: async (token) => {
      calls.push(`logout:${token}`);
      return script.logout.shift() ?? null;
    },
    refresh: async (token) => {
      calls.push(`refresh:${token}`);
      return script.refresh?.shift() ?? null;
    },
  };
  return { d, calls };
}

describe('revokeSession', () => {
  test('a reachable server ends it in one call', async () => {
    const { d, calls } = deps({ logout: [200] });
    assert.deepEqual(await revokeSession(session, d), { done: true });
    assert.deepEqual(calls, ['logout:at-1']);
  });

  test('no connection, a timeout or a 5xx: kept for later, never given up on', async () => {
    for (const status of [null, 502, 503, 504, 429]) {
      const { d } = deps({ logout: [status] });
      assert.deepEqual(await revokeSession(session, d), { done: false, retryWith: session });
    }
  });

  test('an expired access token is renewed once, then the session is ended', async () => {
    const renewed = { accessToken: 'at-2', refreshToken: 'rt-2' };
    const { d, calls } = deps({ logout: [401, 200], refresh: [renewed] });
    assert.deepEqual(await revokeSession(session, d), { done: true });
    assert.deepEqual(calls, ['logout:at-1', 'refresh:rt-1', 'logout:at-2']);
  });

  test('if the renewed session cannot be ended now, the renewed tokens are kept (the old ones no longer work)', async () => {
    const renewed = { accessToken: 'at-2', refreshToken: 'rt-2' };
    const { d } = deps({ logout: [401, null], refresh: [renewed] });
    assert.deepEqual(await revokeSession(session, d), { done: false, retryWith: renewed });
  });

  test('a refresh token the server rejects means the session is over already', async () => {
    const { d } = deps({ logout: [401], refresh: ['ended'] });
    assert.deepEqual(await revokeSession(session, d), { done: true });
  });

  test('a refresh that cannot reach the server keeps the session for later', async () => {
    const { d } = deps({ logout: [401], refresh: [null] });
    assert.deepEqual(await revokeSession(session, d), { done: false, retryWith: session });
  });
});

describe('revokeAll', () => {
  test('keeps exactly the ones that could not be ended, and never loops', async () => {
    const a = { accessToken: 'a', refreshToken: 'ra' };
    const b = { accessToken: 'b', refreshToken: 'rb' };
    const { d, calls } = deps({ logout: [200, null] });
    assert.deepEqual(await revokeAll([a, b], d), [b]);
    assert.equal(calls.length, 2);
  });

  test('an unexpected error keeps that session instead of dropping it', async () => {
    const d: RevocationDeps = {
      logout: async () => {
        throw new Error('boom');
      },
      refresh: async () => null,
    };
    assert.deepEqual(await revokeAll([session], d), [session]);
  });

  test('only the most recent sessions are kept', async () => {
    const many = Array.from({ length: MAX_PENDING_REVOCATIONS + 3 }, (_, i) => ({ accessToken: `a${i}`, refreshToken: `r${i}` }));
    const { d } = deps({ logout: [] });
    const left = await revokeAll(many, d);
    assert.equal(left.length, MAX_PENDING_REVOCATIONS);
    assert.equal(left[0]!.accessToken, `a${3}`);
  });
});
