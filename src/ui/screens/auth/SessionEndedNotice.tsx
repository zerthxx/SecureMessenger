import { useEffect } from 'react';
import { useRouter, useSegments } from 'expo-router';

import { useAuth } from './AuthContext';

/**
 * When the server ends this device's session while the app is in use —
 * terminated from Settings → Devices on another device, "sign out
 * everywhere", or automatic termination after inactivity — AuthContext signs
 * the app out. This takes the user back to the Welcome screen, where
 * SessionEndedBanner explains why.
 *
 * Deliberately no Alert here: an imperative dialog raised while the app is
 * still switching routes (at launch, the splash route is on screen) was not
 * reliably shown on Android. The banner is plain state rendered by the
 * screen the user lands on, so it can't be lost to timing.
 */
export function SessionEndedNotice(): null {
  const router = useRouter();
  const segments = useSegments() as string[];
  const { status, signedOutReason } = useAuth();

  // The splash route (no segment) already sends a signed-out user to
  // Welcome, and the Welcome/auth screens are where they should be anyway.
  const first = segments[0];
  const onEntryRoute = first === undefined || first === 'welcome' || first === '(auth)';

  useEffect(() => {
    if (status !== 'unauthenticated' || signedOutReason !== 'session_ended' || onEntryRoute) return;
    router.replace('/welcome');
  }, [status, signedOutReason, onEntryRoute, router]);

  return null;
}
