import { initTRPC, TRPCError } from '@trpc/server';

import { isProduction } from '../config/env.js';
import { checkRateLimit, RateLimitExceededError } from '../lib/rateLimit.js';
import { SESSION_TERMINATED_MESSAGE } from '../lib/sessions.js';
import type { Context } from './context.js';

const t = initTRPC.context<Context>().create({
  // Audit fix: without an errorFormatter, tRPC's default behavior sends
  // any *unexpected* thrown error's raw `.message` straight to the
  // client when it isn't already a deliberately-thrown TRPCError (e.g. a
  // Postgres constraint violation or driver error would leak internal
  // detail — table/column names, driver internals — to the mobile app).
  // Every deliberate error path in this codebase already throws a
  // crafted TRPCError with a safe message, so this only ever replaces
  // the message on the truly-unhandled-exception path, and only in
  // production — local/dev keeps the real message for debugging. The
  // full original error is still logged server-side via app.ts's
  // top-level onError regardless of what the client receives here.
  errorFormatter({ shape, error }) {
    if (isProduction && error.code === 'INTERNAL_SERVER_ERROR') {
      return { ...shape, message: 'Something went wrong. Please try again.' };
    }
    return shape;
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
/** Lets tests call a router's procedures directly with a hand-built context (see routers/users.test.ts). */
export const createCallerFactory = t.createCallerFactory;

/**
 * Requires a valid, non-expired access token (see context.ts) whose session
 * is still live — not terminated from Settings → Devices, by signing out
 * everywhere, or for inactivity (lib/sessions.ts). Also records the session
 * as active (throttled).
 */
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.user || !ctx.device) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
  }
  if (!(await ctx.sessions.isActive(ctx.user.id, ctx.device.id))) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: SESSION_TERMINATED_MESSAGE });
  }
  ctx.sessions.touch(ctx.device.id, ctx.req.ip);
  return next({ ctx: { ...ctx, user: ctx.user, device: ctx.device } });
});

/**
 * Called directly at the top of a resolver (not `.use()` middleware) so
 * `input` is already parsed and typed by the time it's checked — no
 * fighting tRPC's builder-order generics for something this small.
 * Throws TOO_MANY_REQUESTS; each call is one independent bucket, so a
 * procedure needing both an IP and a username limit calls this twice.
 */
export function enforceRateLimit(key: string, max: number, windowMs: number): void {
  try {
    checkRateLimit(key, max, windowMs);
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many attempts. Please try again shortly.' });
    }
    throw err;
  }
}
