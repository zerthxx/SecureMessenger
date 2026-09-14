import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { SESSION_TTL_MAX_DAYS, SESSION_TTL_MIN_DAYS } from '../../lib/sessions.js';
import { enforceRateLimit, protectedProcedure, router } from '../trpc.js';

const sessionIdInput = z.object({ sessionId: z.string().uuid().transform((id) => id.toLowerCase()) });

const NOT_FOUND_MESSAGE = 'This session is no longer active.';

/**
 * Settings → Devices. Every procedure acts on the caller's own account only:
 * the account id comes from the verified access token, never from input, and
 * SessionManager scopes every read and termination to it — another account's
 * session id is simply "not found". Terminations are enforced server-side at
 * once (see lib/sessions.ts).
 */
export const sessionsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    enforceRateLimit(`sessions:list:device:${ctx.device.id}`, 60, 60 * 1000);
    const [sessions, autoTerminateDays] = await Promise.all([
      ctx.sessions.list(ctx.user.id, ctx.device.id),
      ctx.sessions.getAutoTerminateDays(ctx.user.id),
    ]);
    return { currentSessionId: ctx.device.id, sessions, autoTerminateDays };
  }),

  get: protectedProcedure.input(sessionIdInput).query(async ({ ctx, input }) => {
    enforceRateLimit(`sessions:get:device:${ctx.device.id}`, 60, 60 * 1000);
    const session = await ctx.sessions.get(ctx.user.id, ctx.device.id, input.sessionId);
    if (!session) {
      throw new TRPCError({ code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE });
    }
    return { session };
  }),

  terminate: protectedProcedure.input(sessionIdInput).mutation(async ({ ctx, input }) => {
    enforceRateLimit(`sessions:terminate:user:${ctx.user.id}`, 30, 10 * 60 * 1000);
    const result = await ctx.sessions.terminate(ctx.user.id, ctx.device.id, input.sessionId);
    if (result === 'current') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: "To end this device's session, sign out instead." });
    }
    if (result === 'not_found') {
      throw new TRPCError({ code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE });
    }
    ctx.log.info({ userId: ctx.user.id, terminatedSessionId: input.sessionId }, 'session terminated');
    return { terminated: true as const };
  }),

  terminateAllOthers: protectedProcedure.mutation(async ({ ctx }) => {
    enforceRateLimit(`sessions:terminateAll:user:${ctx.user.id}`, 10, 10 * 60 * 1000);
    const terminatedCount = await ctx.sessions.terminateAllOthers(ctx.user.id, ctx.device.id);
    ctx.log.info({ userId: ctx.user.id, terminatedCount }, 'all other sessions terminated');
    return { terminatedCount };
  }),

  setAutoTerminate: protectedProcedure
    .input(
      z.object({
        days: z
          .number()
          .int('Choose a whole number of days.')
          .min(SESSION_TTL_MIN_DAYS, `Choose at least ${SESSION_TTL_MIN_DAYS} days.`)
          .max(SESSION_TTL_MAX_DAYS, `Choose at most ${SESSION_TTL_MAX_DAYS} days.`),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      enforceRateLimit(`sessions:autoTerminate:user:${ctx.user.id}`, 20, 10 * 60 * 1000);
      const terminatedCount = await ctx.sessions.setAutoTerminateDays(ctx.user.id, ctx.device.id, input.days);
      ctx.log.info({ userId: ctx.user.id, days: input.days, terminatedCount }, 'automatic session termination updated');
      return { autoTerminateDays: input.days, terminatedCount };
    }),
});
