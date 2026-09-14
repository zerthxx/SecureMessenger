import { useEffect, useState } from 'react';

import { getCachedAvatarUri, loadAvatar } from '@/infrastructure/storage/avatarCache';

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
      () => {
        // No photo shown; the initials stay.
      },
    );
    return () => {
      active = false;
    };
  }, [userId, avatarId, cachedUri]);

  if (!avatarId) return null;
  return cachedUri ?? (loaded?.avatarId === avatarId ? loaded.uri : null);
}
