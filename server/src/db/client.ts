import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { env } from '../config/env.js';
import * as schema from './schema.js';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // Keep the pool small by default — this is an API server, not a batch
  // job. Tune only if connection-pool exhaustion is actually observed.
  max: env.DB_POOL_MAX,
});

export const db = drizzle(pool, { schema });

/** `SELECT 1` — used by the readiness check, never by the liveness check. */
export async function pingDatabase(): Promise<void> {
  await pool.query('SELECT 1');
}

/**
 * Pool occupancy, for /health/db and capacity work. `waiting` > 0 means
 * requests are queueing for a connection: the pool (or the database's
 * distance) is the bottleneck, not the CPU.
 */
export function poolStats(): { max: number; total: number; idle: number; waiting: number } {
  return { max: env.DB_POOL_MAX, total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
}

/**
 * pg's Pool emits 'error' for an IDLE client whose backend goes away (the
 * database restarted or was paused, a pooler recycled the connection, a
 * network blip). Node treats an 'error' event with no listener as an
 * uncaught exception, so without this handler one closed idle connection
 * took the whole process down — found by the scale mission's outage test,
 * where a 15 s database interruption became a server crash with every
 * socket dropped. With the listener the pool just discards that client and
 * opens a fresh one on the next query. Logged through the app logger once
 * index.ts hands it over; before that, to stderr.
 */
let logIdleConnectionError = (err: Error): void => {
  console.error(`[db] idle connection lost (${err.message}); the pool will reconnect`);
};
pool.on('error', (err) => logIdleConnectionError(err));

export function setPoolErrorLogger(log: { warn: (obj: object, msg: string) => void }): void {
  logIdleConnectionError = (err) => log.warn({ err }, 'idle database connection lost; the pool will reconnect');
}
