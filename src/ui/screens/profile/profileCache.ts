import type { PublicProfile } from '@/domain/entities';
import { usersApi } from '@/infrastructure/network/trpcClient';

/**
 * In-memory cache of other users' public profiles, shared by every avatar and
 * profile screen. Lookups from components that mount together (a chat list)
 * are coalesced into one `users.getProfiles` request. Nothing polls: an entry
 * is only refetched when something displays it after it has gone stale.
 */

export interface ProfileEntry {
  /** undefined: not loaded yet; null: no such user. */
  profile: PublicProfile | null | undefined;
  fetchedAt: number;
  loading: boolean;
  error: boolean;
  errorAt: number;
}

/** Staleness accepted by list rows; the profile screen asks for fresher data. */
export const DEFAULT_PROFILE_MAX_AGE_MS = 5 * 60 * 1000;
/** After a failed lookup, passive displays wait this long before asking again, so an offline list can't loop requests. */
const ERROR_RETRY_MS = 30 * 1000;
const BATCH_DELAY_MS = 16;
/** The server's cap on ids per `users.getProfiles` call. */
const MAX_IDS_PER_REQUEST = 50;

export const EMPTY_PROFILE_ENTRY: ProfileEntry = { profile: undefined, fetchedAt: 0, loading: false, error: false, errorAt: 0 };

const entries = new Map<string, ProfileEntry>();
const listeners = new Map<string, Set<() => void>>();
const queued = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
// Bumped by clearProfileCache, so responses that land after sign-out are dropped.
let generation = 0;

function setEntry(userId: string, entry: ProfileEntry): void {
  entries.set(userId, entry);
  listeners.get(userId)?.forEach((listener) => listener());
}

export function getProfileEntry(userId: string): ProfileEntry {
  return entries.get(userId) ?? EMPTY_PROFILE_ENTRY;
}

export function subscribeToProfile(userId: string, listener: () => void): () => void {
  const userListeners = listeners.get(userId) ?? new Set<() => void>();
  listeners.set(userId, userListeners);
  userListeners.add(listener);
  return () => {
    userListeners.delete(listener);
    if (userListeners.size === 0) listeners.delete(userId);
  };
}

/**
 * Fetches a profile unless the cached copy is younger than `maxAgeMs`. Cheap
 * enough to call on every mount; `maxAgeMs` 0 forces a refetch (a retry).
 */
export function requestProfile(userId: string, maxAgeMs: number = DEFAULT_PROFILE_MAX_AGE_MS): void {
  const entry = getProfileEntry(userId);
  if (entry.loading) return;
  const now = Date.now();
  if (entry.profile !== undefined && now - entry.fetchedAt < maxAgeMs) return;
  if (entry.error && maxAgeMs > 0 && now - entry.errorAt < ERROR_RETRY_MS) return;

  queued.add(userId);
  setEntry(userId, { ...entry, loading: true });
  if (!flushTimer) flushTimer = setTimeout(flushQueue, BATCH_DELAY_MS);
}

function flushQueue(): void {
  flushTimer = null;
  const userIds = [...queued];
  queued.clear();
  const requestGeneration = generation;

  for (let start = 0; start < userIds.length; start += MAX_IDS_PER_REQUEST) {
    const batch = userIds.slice(start, start + MAX_IDS_PER_REQUEST);
    usersApi.getProfiles({ userIds: batch }).then(
      ({ profiles }) => {
        if (requestGeneration !== generation) return;
        const now = Date.now();
        const byId = new Map(profiles.map((profile) => [profile.id, profile]));
        for (const userId of batch) {
          setEntry(userId, { profile: byId.get(userId) ?? null, fetchedAt: now, loading: false, error: false, errorAt: 0 });
        }
      },
      () => {
        if (requestGeneration !== generation) return;
        const now = Date.now();
        for (const userId of batch) {
          setEntry(userId, { ...getProfileEntry(userId), loading: false, error: true, errorAt: now });
        }
      },
    );
  }
}

/** Forgets every profile — called on sign-out, so one account's lookups never carry over to the next. */
export function clearProfileCache(): void {
  generation += 1;
  queued.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const userIds = [...entries.keys()];
  entries.clear();
  for (const userId of userIds) {
    listeners.get(userId)?.forEach((listener) => listener());
  }
}
