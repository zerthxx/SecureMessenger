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
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Prevent unbounded growth from being hammered with unique keys.
const MAX_TRACKED_KEYS = 50_000;

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
    if (buckets.size >= MAX_TRACKED_KEYS) {
      buckets.clear();
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }

  if (existing.count >= max) {
    throw new RateLimitExceededError(existing.resetAt - now);
  }

  existing.count += 1;
}
