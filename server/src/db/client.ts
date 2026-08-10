import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { env } from '../config/env.js';
import * as schema from './schema.js';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // Keep the pool small by default — this is an API server, not a batch
  // job. Tune only if connection-pool exhaustion is actually observed.
  max: 10,
});

export const db = drizzle(pool, { schema });

/** `SELECT 1` — used by the readiness check, never by the liveness check. */
export async function pingDatabase(): Promise<void> {
  await pool.query('SELECT 1');
}
