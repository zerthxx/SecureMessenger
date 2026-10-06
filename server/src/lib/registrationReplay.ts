/**
 * Makes `auth.register` safe to repeat. A sign-up whose response is lost
 * (Android's HTTP client silently re-sends a POST when the connection dies
 * after the request went out; the app timing out; the user tapping again)
 * used to come back as "That username is already taken" — for the account
 * the user had just created, whose recovery code they never saw. The app
 * now sends a random `registrationId`, the same for every retry of one
 * sign-up; a repeat within the window gets the original outcome instead of
 * a second attempt, including while the first is still running.
 *
 * In memory, like rateLimit.ts and recoveryTokenStore.ts: right for the
 * single-instance deployment, and retries arrive within seconds — a server
 * restart in between just means the old "already taken" answer.
 */

/** Long enough for a timed-out request plus a manual retry. */
export const REGISTRATION_REPLAY_TTL_MS = 5 * 60 * 1000;
const MAX_TRACKED = 10_000;

interface Entry<T> {
  promise: Promise<T>;
  expiresAt: number;
}

export function createReplayCache<T>(ttlMs: number = REGISTRATION_REPLAY_TTL_MS, now: () => number = Date.now) {
  const entries = new Map<string, Entry<T>>();

  const sweep = (at: number) => {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(key);
    }
  };

  return {
    /**
     * Runs `task` for `key`, or — when the same key ran within the window
     * and didn't fail — hands back that run's outcome (`replayed: true`). A
     * failed run is forgotten, so retrying it runs again.
     */
    run(key: string, task: () => Promise<T>): { promise: Promise<T>; replayed: boolean } {
      const at = now();
      const existing = entries.get(key);
      if (existing && existing.expiresAt > at) return { promise: existing.promise, replayed: true };
      if (entries.size >= MAX_TRACKED) sweep(at);
      if (entries.size >= MAX_TRACKED) return { promise: task(), replayed: false };

      const promise = task();
      const entry: Entry<T> = { promise, expiresAt: at + ttlMs };
      entries.set(key, entry);
      promise.catch(() => {
        if (entries.get(key) === entry) entries.delete(key);
      });
      return { promise, replayed: false };
    },
    get size(): number {
      return entries.size;
    },
  };
}
