import { useCallback } from 'react';
import { useRouter, type Href } from 'expo-router';

import { useAuth } from '@/ui/screens/auth/AuthContext';

/** Opens a user's profile: the read-only public profile for someone else, the existing edit screen for yourself. */
export function useOpenUserProfile(): (userId: string) => void {
  const router = useRouter();
  const { user } = useAuth();
  const ownUserId = user?.id;

  return useCallback(
    (userId: string) => {
      if (userId === ownUserId) {
        router.push('/settings/edit-profile');
        return;
      }
      // Cast: see NewConversationScreen — expo-router's generated route types
      // only pick up a new dynamic route on the next dev-server run.
      router.push({ pathname: '/user/[id]', params: { id: userId } } as unknown as Href);
    },
    [router, ownUserId],
  );
}
