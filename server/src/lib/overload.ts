import { TRPCError } from '@trpc/server';

/**
 * Load shedding for the database connection pool (docs/ENGINEERING_CHECKLIST.md,
 * scale readiness, S5).
 *
 * What overload looks like here: every request needs a pooled connection,
 * each statement holds one for a full round trip to the database (~145 ms in
 * production), and pg's pool has an unbounded wait queue. Measured locally
 * at 200 users against a pool of 10 behind a 150 ms proxy: `pool.waiting`
 * climbed past 200 and every request — sends included — took 6–11 s, while
 * nothing was refused. Clients then time out and retry, which adds load.
 *
 * Policy: while more requests are waiting for a connection than
 * `threshold`, the *polling* procedures (chat list, message fetch, key
 * package status) are answered at once with TOO_MANY_REQUESTS and a
 * `Retry-After`, before they touch the database. They are safe to refuse:
 * the app polls again on its own schedule (backed off, jittered), nothing
 * is lost or duplicated, and the realtime hint that prompted a fetch is
 * repeated by the next poll. Sends, authentication, session changes and
 * the realtime socket are never shed: a send that reached the server must
 * be stored (it is idempotent, so a timed-out send is retried safely by the
 * app), and refusing auth would log people out of a busy server.
 *
 * `Retry-After` grows with the queue so retries spread out instead of
 * landing together when the queue drains.
 */

export interface PoolPressure {
  /** Requests currently waiting for a pooled connection. */
  waiting: number;
  /** The pool's size, for scaling the retry delay. */
  max: number;
}

export const MIN_RETRY_AFTER_S = 5;
export const MAX_RETRY_AFTER_S = 30;

/** Whether polling work should be refused right now. `threshold` 0 disables shedding. */
export function shouldShed(pressure: PoolPressure, threshold: number): boolean {
  return threshold > 0 && pressure.waiting > threshold;
}

/** Seconds the client should wait: 5 s at the threshold, up to 30 s when the queue is many pools deep. */
export function retryAfterSeconds(pressure: PoolPressure, threshold: number): number {
  const depth = threshold > 0 ? pressure.waiting / threshold : 0;
  return Math.min(MAX_RETRY_AFTER_S, Math.max(MIN_RETRY_AFTER_S, Math.round(MIN_RETRY_AFTER_S * depth)));
}

export const SERVER_BUSY_MESSAGE = 'The server is busy. Please try again shortly.';

/**
 * A tRPC middleware body: refuses the call while the pool is overloaded.
 * `readPressure` and `threshold` are injected so the policy is unit tested
 * without a database; `setRetryAfter` writes the response header.
 */
export function shedIfOverloaded(
  readPressure: () => PoolPressure,
  threshold: number,
  setRetryAfter: (seconds: number) => void,
  onShed?: (pressure: PoolPressure, retryAfter: number) => void,
): void {
  const pressure = readPressure();
  if (!shouldShed(pressure, threshold)) return;
  const retryAfter = retryAfterSeconds(pressure, threshold);
  setRetryAfter(retryAfter);
  onShed?.(pressure, retryAfter);
  throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: SERVER_BUSY_MESSAGE });
}
