import type { FastifyInstance } from 'fastify';

import { pingDatabase, poolStats } from '../db/client.js';

/**
 * Plain REST, not tRPC — health checks are read by infrastructure
 * (load balancers, Fly.io, uptime monitors) that expects a bare HTTP
 * GET, not an RPC envelope.
 *
 * Split liveness from readiness on purpose: a load balancer should stop
 * routing traffic to a instance whose database is unreachable (readiness)
 * without necessarily restarting the process (liveness).
 */
export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({
    status: 'ok' as const,
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.get('/health/db', async (_req, reply) => {
    try {
      const start = Date.now();
      await pingDatabase();
      // `pool.waiting` > 0 means requests are queueing for a connection.
      return { status: 'ok' as const, database: 'reachable' as const, latencyMs: Date.now() - start, pool: poolStats() };
    } catch (err) {
      app.log.error({ err }, 'readiness check failed: database unreachable');
      return reply.status(503).send({ status: 'error' as const, database: 'unreachable' as const, pool: poolStats() });
    }
  });
}
