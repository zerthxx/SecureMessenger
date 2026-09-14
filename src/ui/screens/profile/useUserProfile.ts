import { useCallback, useEffect, useSyncExternalStore } from 'react';

import type { PublicProfile } from '@/domain/entities';
import { EMPTY_PROFILE_ENTRY, getProfileEntry, requestProfile, subscribeToProfile } from './profileCache';

export type UserProfileStatus = 'loading' | 'ready' | 'not_found' | 'error';

const noopUnsubscribe = () => {};

/**
 * Another user's public profile from the shared cache, fetched (batched with
 * other lookups) when missing or older than `maxAgeMs`. A null id skips the
 * lookup. A stale profile stays `ready` while it refreshes — no flicker.
 */
export function useUserProfile(
  userId: string | null | undefined,
  { maxAgeMs }: { maxAgeMs?: number } = {},
): { profile: PublicProfile | null; status: UserProfileStatus; reload: () => void } {
  const subscribe = useCallback(
    (listener: () => void) => (userId ? subscribeToProfile(userId, listener) : noopUnsubscribe),
    [userId],
  );
  const entry = useSyncExternalStore(subscribe, () => (userId ? getProfileEntry(userId) : EMPTY_PROFILE_ENTRY));

  useEffect(() => {
    if (userId) requestProfile(userId, maxAgeMs);
  }, [userId, maxAgeMs]);

  const reload = useCallback(() => {
    if (userId) requestProfile(userId, 0);
  }, [userId]);

  const status: UserProfileStatus = entry.profile
    ? 'ready'
    : entry.profile === null
      ? 'not_found'
      : entry.error
        ? 'error'
        : 'loading';
  return { profile: entry.profile ?? null, status, reload };
}
