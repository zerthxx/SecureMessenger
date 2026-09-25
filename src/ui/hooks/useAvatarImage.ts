import { useEffect, useState } from 'react';

import { statusOf } from '@/infrastructure/network/transientFailures';
import { getCachedAvatarUri, loadAvatar } from '@/infrastructure/storage/avatarCache';
import { requestProfile } from '@/ui/screens/profile/profileCache';

/**
 * The photo id last shown for each user in this session. While a user's new
 * photo can't be downloaded yet (slow network, a 5xx from the server), their
 * previous photo — still in the on-disk cache, already seen by this viewer —
 * stays on screen instead of dropping back to initials. Never used once the
 * user has no photo (`avatarId` null): a removed photo is never shown again.
 */
const lastShownAvatarId = new Map<string, string>();

/**
 * The local uri of a user's profile photo — or null while it downloads, when
 * they have none, or if it can't be loaded (the Avatar keeps showing initials
 * then). A photo already in the cache resolves on the first render.
 */
export function useAvatarImage(userId: string | null | undefined, avatarId: string | null | undefined): string | null {
  const [loaded, setLoaded] = useState<{ avatarId: string; uri: string } | null>(null);
  const cachedUri = avatarId ? getCachedAvatarUri(avatarId) : null;

  useEffect(() => {
    if (!userId || !avatarId || cachedUri) return;
    let active = true;
    loadAvatar(userId, avatarId).then(
      (uri) => {
        if (active) setLoaded({ avatarId, uri });
      },
      (err: unknown) => {
        // No photo shown; the initials (or the previous photo) stay. A 404
        // means this photo id is out of date — the user changed or removed
        // their photo since the profile was fetched — so fetch it again.
        if (statusOf(err) === 404) requestProfile(userId, 0);
      },
    );
    return () => {
      active = false;
    };
  }, [userId, avatarId, cachedUri]);

  if (!avatarId) return null;
  const current = cachedUri ?? (loaded?.avatarId === avatarId ? loaded.uri : null);
  if (current) {
    if (userId) lastShownAvatarId.set(userId, avatarId);
    return current;
  }
  const previousId = userId ? lastShownAvatarId.get(userId) : undefined;
  return previousId ? getCachedAvatarUri(previousId) : null;
}
