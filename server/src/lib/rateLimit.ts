/**
 * In-memory fixed-window rate limiter — a deliberate stopgap.
 *
 * The Phase 2 ADR names Redis as the place counters like this eventually
 * live, specifically because an in-memory Map only rate-limits *this*
 * process: it stops protecting anything the moment the API runs on more
 * than one instance. That's an acceptable tradeoff for the current
 * single-instance deployment and an explicit limitation once Redis
 * fan-out (a later phase) makes the API horizontally scaled — moving
 * this to Redis is that phase's responsibility, not a surprise.
 */
import { isIPv4, isIPv6 } from 'node:net';

import type { FastifyReply } from 'fastify';

interface Bucket {
  count: number;
  resetAt: number;
}

// Insertion-ordered, so the first entries are the oldest windows.
const buckets = new Map<string, Bucket>();

// Prevent unbounded growth from being hammered with unique keys.
const MAX_TRACKED_KEYS = 50_000;

/**
 * Makes room once MAX_TRACKED_KEYS is reached: drops expired windows, then
 * — only if the map is still full of live ones — the oldest tenth. It used
 * to clear every bucket, so a flood of throwaway keys (fresh IPv6 addresses
 * are free) reset everyone's counters, including the per-username login
 * limit that stops a distributed password-guessing run against one account.
 */
function makeRoom(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  if (buckets.size < MAX_TRACKED_KEYS) return;
  let excess = buckets.size - Math.floor(MAX_TRACKED_KEYS * 0.9);
  for (const key of buckets.keys()) {
    if (excess-- <= 0) break;
    buckets.delete(key);
  }
}

/**
 * The part of a client address a per-IP limit should count. An IPv6 client
 * is normally handed a whole /64, so counting individual addresses would
 * give a single attacker 2^64 separate budgets; its /64 is counted instead.
 * IPv4 (also IPv4-mapped IPv6, as dual-stack sockets report it) is kept
 * whole. Anything unparseable is returned unchanged.
 */
export function ipBucket(ip: string): string {
  const address = ip.split('%')[0]!.toLowerCase();
  if (isIPv4(address)) return address;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped && isIPv4(mapped[1]!)) return mapped[1]!;
  if (!isIPv6(address)) return ip;
  const [head = '', tail] = address.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const groups =
    tail === undefined ? headGroups : [...headGroups, ...Array<string>(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups];
  return `${groups
    .slice(0, 4)
    .map((group) => (parseInt(group, 16) || 0).toString(16))
    .join(':')}::/64`;
}

export class RateLimitExceededError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super('Rate limit exceeded');
    this.name = 'RateLimitExceededError';
  }
}

/**
 * Test-only: buckets are module-level state shared across test cases,
 * so a suite asserting on counters must start from a known-empty map.
 * Not referenced by any production code path.
 */
export function __resetRateLimitsForTest(): void {
  buckets.clear();
}

export function checkRateLimit(key: string, max: number, windowMs: number): void {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    // A renewed window moves to the end, where eviction reaches it last.
    if (existing) buckets.delete(key);
    else if (buckets.size >= MAX_TRACKED_KEYS) makeRoom(now);
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }

  if (existing.count >= max) {
    throw new RateLimitExceededError(existing.resetAt - now);
  }

  existing.count += 1;
}

/**
 * For plain Fastify routes, which have no tRPC-style error mapping: sends a
 * 429 and returns true when `key` is over its limit, so the handler can
 * `return` straight away.
 */
export function replyIfRateLimited(reply: FastifyReply, key: string, max: number, windowMs: number): boolean {
  try {
    checkRateLimit(key, max, windowMs);
    return false;
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      reply.status(429).send({ error: 'Too many attempts. Please try again shortly.' });
      return true;
    }
    throw err;
  }
}
