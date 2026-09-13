import { TRPCError } from '@trpc/server';
import { and, eq, ilike, ne } from 'drizzle-orm';
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
/**
 * Audit fix: without escaping, a caller's raw query could contain LIKE
 * wildcard characters (`%`, `_`) that change match breadth rather than
 * meaning what the user typed literally — e.g. searching "a_b" would
 * also match "axb". Not a security issue (drizzle already parameterizes
 * the value, so this was never SQL-injectable), just incorrect search
 * semantics. Postgres's default LIKE/ILIKE escape character is `\`, so
 * escaping backslash itself first, then the two wildcard characters, is
 * sufficient with no ESCAPE clause needed.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export const usersRouter = router({
  search: protectedProcedure.input(z.object({ query: z.string().trim().min(1).max(32) })).query(async ({ ctx, input }) => {
    // Read-only, but still a user-enumeration primitive — bounded
    // generously enough for normal typeahead use while blunting a
    // scripted username scan.
    enforceRateLimit(`users:search:device:${ctx.device.id}`, 30, 60 * 1000);

    const needle = escapeLikePattern(normalizeUsername(input.query));
    const rows = await ctx.db
      .select({ id: users.id, username: users.username, displayName: users.displayName })
      .from(users)
      .where(and(ilike(users.username, `${needle}%`), ne(users.id, ctx.user.id)))
      .limit(20);
    return rows;
  }),

  /**
   * Updates the caller's own public profile. The display name is the only
   * user-editable profile field — the username is the account's lookup key
   * and can't change. Same length rule as registration (auth.register).
   */
  updateProfile: protectedProcedure
    .input(
      z.object({
        displayName: z
          .string()
          .trim()
          .min(1, 'Display name cannot be empty.')
          .max(50, 'Display name must be 50 characters or fewer.'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      enforceRateLimit(`users:updateProfile:user:${ctx.user.id}`, 20, 10 * 60 * 1000);

      const [user] = await ctx.db
        .update(users)
        .set({ displayName: input.displayName, updatedAt: new Date() })
        .where(eq(users.id, ctx.user.id))
        .returning({ id: users.id, username: users.username, displayName: users.displayName });

      if (!user) {
        throw new TRPCError({ code: 'UNAUTHORIZED' });
      }
      ctx.log.info({ userId: user.id }, 'profile updated');
      return { user };
    }),
});
