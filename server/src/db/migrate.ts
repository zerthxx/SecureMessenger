import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import { env } from '../config/env.js';

/**
 * One-shot migration runner: `npm run db:migrate`. Separate from the
 * long-lived app pool in `client.ts` on purpose — this connection exists
 * only for the duration of the migration.
 */
async function main() {
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
  const db = drizzle(pool);

  console.log('Running migrations…');
  await migrate(db, { migrationsFolder: 'src/db/migrations' });
  console.log('Migrations complete.');

  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
