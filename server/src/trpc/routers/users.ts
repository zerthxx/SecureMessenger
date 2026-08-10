import { and, ilike, ne } from 'drizzle-orm';
import { z } from 'zod';

import { users } from '../../db/schema.js';
import { normalizeUsername } from '../../lib/username.js';
import { enforceRateLimit, protectedProcedure, router } from '../trpc.js';

/**
 * Phase 6: the one piece User A needs to start a 1:1 conversation with
 * User B — finding B's account id from a username. No such lookup
 * existed before this (every prior E2EE endpoint took a userId/deviceId
 * the caller already had). Returns public profile fields only (id,
 * username, displayName) — nothing from `devices`/`deviceKeyPackages`.
 */
export const usersRouter = router({
  search: protectedProcedure.input(z.object({ query: z.string().trim().min(1).max(32) })).query(async ({ ctx, input }) => {
    // Read-only, but still a user-enumeration primitive — bounded
    // generously enough for normal typeahead use while blunting a
    // scripted username scan.
    enforceRateLimit(`users:search:device:${ctx.device.id}`, 30, 60 * 1000);

    const needle = normalizeUsername(input.query);
    const rows = await ctx.db
      .select({ id: users.id, username: users.username, displayName: users.displayName })
      .from(users)
      .where(and(ilike(users.username, `${needle}%`), ne(users.id, ctx.user.id)))
      .limit(20);
    return rows;
  }),
});
