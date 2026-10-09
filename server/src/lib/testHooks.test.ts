import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import websocket from '@fastify/websocket';
import fastify, { type FastifyInstance } from 'fastify';

// The hooks are read from the environment when the module loads, so the
// variable is set before the (dynamic) import below. The suite runs with
// NODE_ENV=development, where hooks are honoured; in production they are
// forced off at the same place (lib/testHooks.ts), which cannot be exercised
// from one process and is covered by reading `isProduction` there.
process.env.E2EE_TEST_REALTIME_DOWN = '1';

describe('local fault-injection hooks', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  test('E2EE_TEST_REALTIME_DOWN refuses every realtime upgrade with 503 while HTTP routes keep working', async () => {
    const { realtimeDownForTest, testHooksActive } = await import('./testHooks.js');
    const { realtimeRoutes } = await import('../http/realtime.js');
    const { CallRegistry } = await import('../realtime/callRegistry.js');
    const { RealtimeHub } = await import('../realtime/hub.js');
    assert.equal(realtimeDownForTest(), true);
    assert.equal(testHooksActive(), true);

    const hub = new RealtimeHub();
    const calls = new CallRegistry({
      toDevice: (deviceId, event) => hub.toDevice(deviceId, event),
      toUser: (userId, event, options) => hub.toUser(userId, event, options),
      wakeCallee: () => {},
      cancelWake: () => {},
    });
    app = fastify();
    await app.register(websocket);
    await app.register(realtimeRoutes, {
      hub,
      calls,
      // A valid session: only the hook stands in the way.
      authenticate: async () => ({ userId: 'user-alice', deviceId: 'alice-phone', expiresAt: Date.now() + 60_000 }),
      isDeviceActive: async () => true,
      isDeviceRevoked: () => false,
      findCallee: async () => null,
    });
    app.get('/health', async () => ({ status: 'ok' }));
    await app.ready();

    await assert.rejects(app.injectWS('/realtime', { headers: { authorization: 'Bearer token-alice' } }), /503/);
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
  });
});
