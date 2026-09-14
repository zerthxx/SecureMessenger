import { TRPCError } from '@trpc/server';
import { and, ilike, ne } from 'drizzle-orm';
import { z } from 'zod';

import { users } from '../../db/schema.js';
import {
  BIRTHDAY_VISIBILITY_VALUES,
  bioSchema,
  birthdaySchema,
  displayNameSchema,
  toOwnProfile,
  toPublicProfile,
  type ProfileStore,
  type ProfileUpdate,
} from '../../lib/profile.js';
import { createDbProfileStore } from '../../lib/profileStore.js';
import { normalizeUsername } from '../../lib/username.js';
import type { Context } from '../context.js';
import { enforceRateLimit, protectedProcedure, router } from '../trpc.js';

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

/** Most profiles one `getProfiles` call returns — enough for a screenful of chats. */
const MAX_PROFILES_PER_REQUEST = 50;

interface UsersRouterDeps {
  /** Resolves the profile store for a request. Tests pass an in-memory store; see users.test.ts. */
  profiles: (ctx: Context) => ProfileStore;
}

export function createUsersRouter({ profiles }: UsersRouterDeps) {
  return router({
    /**
     * Phase 6: the one piece User A needs to start a 1:1 conversation with
     * User B — finding B's account id from a username. Returns public
     * profile fields only (id, username, displayName, avatarId) — nothing
     * from `devices`/`deviceKeyPackages`.
     */
    search: protectedProcedure.input(z.object({ query: z.string().trim().min(1).max(32) })).query(async ({ ctx, input }) => {
      // Read-only, but still a user-enumeration primitive — bounded
      // generously enough for normal typeahead use while blunting a
      // scripted username scan.
      enforceRateLimit(`users:search:device:${ctx.device.id}`, 30, 60 * 1000);

      const needle = escapeLikePattern(normalizeUsername(input.query));
      const rows = await ctx.db
        .select({ id: users.id, username: users.username, displayName: users.displayName, avatarId: users.avatarId })
        .from(users)
        .where(and(ilike(users.username, `${needle}%`), ne(users.id, ctx.user.id)))
        .limit(20);
      return rows;
    }),

    /** The caller's own profile, including the full birthday and who may see it. */
    me: protectedProcedure.query(async ({ ctx }) => {
      const record = await profiles(ctx).findById(ctx.user.id);
      if (!record) {
        throw new TRPCError({ code: 'UNAUTHORIZED' });
      }
      return { profile: toOwnProfile(record) };
    }),

    /**
     * Public profiles of other users, as anyone signed in may see them — the
     * same audience `search` already exposes usernames and display names to.
     * Only the `toPublicProfile` projection leaves the server: the birthday is
     * reduced to what its owner allows, and nothing account- or device-level
     * is ever included. Unknown ids are simply absent from the result.
     */
    getProfiles: protectedProcedure
      .input(z.object({ userIds: z.array(z.string().uuid()).min(1).max(MAX_PROFILES_PER_REQUEST) }))
      .query(async ({ ctx, input }) => {
        enforceRateLimit(`users:getProfiles:device:${ctx.device.id}`, 60, 60 * 1000);

        const userIds = [...new Set(input.userIds.map((id) => id.toLowerCase()))];
        const records = await profiles(ctx).findByIds(userIds);
        const byId = new Map(records.map((record) => [record.id, record]));
        return {
          profiles: userIds.flatMap((id) => {
            const record = byId.get(id);
            return record ? [toPublicProfile(record)] : [];
          }),
        };
      }),

    /**
     * Updates the caller's own profile — only fields present in the input
     * change. The username is the account's lookup key and can't change.
     * Older app versions send `{ displayName }` alone, which stays valid, and
     * the response keeps their `user.id/username/displayName` shape.
     */
    updateProfile: protectedProcedure
      .input(
        z
          .object({
            displayName: displayNameSchema.optional(),
            // null or an empty/whitespace-only string both clear the bio.
            bio: bioSchema.nullable().optional(),
            // `YYYY-MM-DD`; null clears it.
            birthday: birthdaySchema.nullable().optional(),
            birthdayVisibility: z.enum(BIRTHDAY_VISIBILITY_VALUES).optional(),
          })
          .refine((input) => Object.values(input).some((value) => value !== undefined), { message: 'Nothing to update.' }),
      )
      .mutation(async ({ ctx, input }) => {
        enforceRateLimit(`users:updateProfile:user:${ctx.user.id}`, 20, 10 * 60 * 1000);

        const patch: ProfileUpdate = {};
        if (input.displayName !== undefined) patch.displayName = input.displayName;
        if (input.bio !== undefined) patch.bio = input.bio;
        if (input.birthday !== undefined) patch.birthday = input.birthday;
        if (input.birthdayVisibility !== undefined) patch.birthdayVisibility = input.birthdayVisibility;

        const record = await profiles(ctx).update(ctx.user.id, patch);
        if (!record) {
          throw new TRPCError({ code: 'UNAUTHORIZED' });
        }
        // Field names only — never the bio or birthday values themselves.
        ctx.log.info({ userId: record.id, fields: Object.keys(patch) }, 'profile updated');
        return { user: toOwnProfile(record) };
      }),
  });
}

export const usersRouter = createUsersRouter({ profiles: (ctx) => createDbProfileStore(ctx.db) });
