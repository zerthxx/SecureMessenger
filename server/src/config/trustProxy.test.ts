import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';

import fastify from 'fastify';

import { checkRateLimit, RateLimitExceededError, __resetRateLimitsForTest } from '../lib/rateLimit.js';
import { RAILWAY_TRUST_PROXY, resolveTrustProxy } from './trustProxy.js';

describe('resolveTrustProxy', () => {
  test('defaults to trusting nothing outside production', () => {
    assert.equal(resolveTrustProxy(undefined, false), false);
  });

  test('defaults to the Railway proxy range in production', () => {
    assert.equal(resolveTrustProxy(undefined, true), RAILWAY_TRUST_PROXY);
  });

  test('parses explicit disable forms', () => {
    assert.equal(resolveTrustProxy('false', true), false);
    assert.equal(resolveTrustProxy('', true), false);
    assert.equal(resolveTrustProxy('   ', true), false);
  });

  test('parses hop counts as numbers', () => {
    assert.equal(resolveTrustProxy('1', false), 1);
    assert.equal(resolveTrustProxy('2', false), 2);
  });

  test('passes CIDR lists through verbatim', () => {
    assert.equal(resolveTrustProxy('10.0.0.0/8,loopback', false), '10.0.0.0/8,loopback');
  });
});

/**
 * The security property under test: `request.ip` must be the real
 * client, and must NOT be anything a client can put in a header itself.
 *
 * `remoteAddress` in `app.inject` stands in for the TCP peer — on
 * Railway that is always an edge-proxy address in 100.0.0.0/8, never an
 * end user, because containers are not directly reachable.
 */
// Deliberately does not call `ready()` — `inject()` boots the instance
// on demand, and readying here would lock out tests that register an
// additional route before injecting.
async function ipEcho(trustProxy: boolean | number | string) {
  const app = fastify({ trustProxy });
  app.get('/ip', async (req) => ({ ip: req.ip }));
  return app;
}

describe('client IP resolution behind a proxy', () => {
  test('resolves the forwarded client IP when the edge replaces the header', async () => {
    const app = await ipEcho(RAILWAY_TRUST_PROXY);
    const res = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '100.64.0.1',
      headers: { 'x-forwarded-for': '203.0.113.5' },
    });
    assert.equal(res.json().ip, '203.0.113.5');
    await app.close();
  });

  test('SPOOFING: a client-prepended X-Forwarded-For entry is never returned', async () => {
    // Attacker sends `X-Forwarded-For: 1.2.3.4`; the edge appends the
    // real peer, producing "1.2.3.4, 203.0.113.5". The walk must stop
    // at the real client and never reach the attacker's value.
    const app = await ipEcho(RAILWAY_TRUST_PROXY);
    const res = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '100.64.0.1',
      headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.5' },
    });
    assert.equal(res.json().ip, '203.0.113.5');
    assert.notEqual(res.json().ip, '1.2.3.4');
    await app.close();
  });

  test('SPOOFING: a long forged chain still resolves to the real client', async () => {
    const app = await ipEcho(RAILWAY_TRUST_PROXY);
    const res = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '100.64.0.1',
      headers: { 'x-forwarded-for': '9.9.9.9, 8.8.8.8, 7.7.7.7, 203.0.113.5' },
    });
    assert.equal(res.json().ip, '203.0.113.5');
    await app.close();
  });

  test('SPOOFING: forged headers are ignored entirely when proxy trust is off', async () => {
    const app = await ipEcho(false);
    const res = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '198.51.100.7',
      headers: { 'x-forwarded-for': '1.2.3.4' },
    });
    assert.equal(res.json().ip, '198.51.100.7');
    await app.close();
  });

  test('two different clients behind the same proxy resolve to different IPs', async () => {
    const app = await ipEcho(RAILWAY_TRUST_PROXY);
    const a = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '100.64.0.1',
      headers: { 'x-forwarded-for': '203.0.113.5' },
    });
    const b = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '100.64.0.1',
      headers: { 'x-forwarded-for': '198.51.100.9' },
    });
    assert.notEqual(a.json().ip, b.json().ip);
    await app.close();
  });
});

describe('per-IP rate limit buckets are independent', () => {
  beforeEach(() => {
    __resetRateLimitsForTest();
  });

  test('exhausting one client bucket does not affect another client', async () => {
    const app = await ipEcho(RAILWAY_TRUST_PROXY);
    app.get('/limited', async (req, reply) => {
      try {
        checkRateLimit(`login:ip:${req.ip}`, 3, 60_000);
        return { ok: true };
      } catch (err) {
        if (err instanceof RateLimitExceededError) return reply.status(429).send({ ok: false });
        throw err;
      }
    });
    await app.ready();

    const call = (forwardedFor: string) =>
      app.inject({
        method: 'GET',
        url: '/limited',
        remoteAddress: '100.64.0.1',
        headers: { 'x-forwarded-for': forwardedFor },
      });

    // Attacker exhausts their own bucket.
    assert.equal((await call('203.0.113.5')).statusCode, 200);
    assert.equal((await call('203.0.113.5')).statusCode, 200);
    assert.equal((await call('203.0.113.5')).statusCode, 200);
    assert.equal((await call('203.0.113.5')).statusCode, 429);

    // A different client is completely unaffected — this is the
    // property that was broken when every request shared one bucket.
    assert.equal((await call('198.51.100.9')).statusCode, 200);
    assert.equal((await call('198.51.100.9')).statusCode, 200);

    await app.close();
  });

  test('an attacker cannot evade their own bucket by forging headers', async () => {
    const app = await ipEcho(RAILWAY_TRUST_PROXY);
    app.get('/limited', async (req, reply) => {
      try {
        checkRateLimit(`login:ip:${req.ip}`, 2, 60_000);
        return { ok: true };
      } catch (err) {
        if (err instanceof RateLimitExceededError) return reply.status(429).send({ ok: false });
        throw err;
      }
    });
    await app.ready();

    // Every request comes from the same real client, but each forges a
    // different leading XFF entry hoping for a fresh bucket.
    const forge = (fake: string) =>
      app.inject({
        method: 'GET',
        url: '/limited',
        remoteAddress: '100.64.0.1',
        headers: { 'x-forwarded-for': `${fake}, 203.0.113.5` },
      });

    assert.equal((await forge('1.1.1.1')).statusCode, 200);
    assert.equal((await forge('2.2.2.2')).statusCode, 200);
    assert.equal((await forge('3.3.3.3')).statusCode, 429);

    await app.close();
  });
});
