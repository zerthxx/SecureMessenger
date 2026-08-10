import { sql } from 'drizzle-orm';

import { publicProcedure, router } from '../trpc.js';

/** Unauthenticated diagnostics — proves the tRPC + DB wiring works end to end. */
export const systemRouter = router({
  ping: publicProcedure.query(() => ({
    status: 'ok' as const,
    time: new Date().toISOString(),
  })),

  health: publicProcedure.query(async ({ ctx }) => {
    const start = Date.now();
    await ctx.db.execute(sql`SELECT 1`);
    return {
      status: 'ok' as const,
      database: 'reachable' as const,
      latencyMs: Date.now() - start,
    };
  }),
});
