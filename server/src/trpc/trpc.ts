import { initTRPC, TRPCError } from '@trpc/server';

import { checkRateLimit, RateLimitExceededError } from '../lib/rateLimit.js';
import type { Context } from './context.js';

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

/** Requires a valid, non-expired access token. See context.ts for what "valid" checks. */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user || !ctx.device) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
  }
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
