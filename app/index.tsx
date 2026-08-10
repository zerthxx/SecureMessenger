import { useEffect } from 'react';
import { useRouter } from 'expo-router';

import { SplashScreen, useAuth } from '@/ui/screens';

const MIN_SPLASH_DURATION_MS = 900;

export default function Index(): React.JSX.Element {
  const router = useRouter();
  const { status } = useAuth();

  useEffect(() => {
    // `status` starts 'loading' while AuthProvider tries a silent
    // refresh against the stored session; wait for it to settle so a
    // returning, still-logged-in user lands on Home, not Welcome.
    if (status === 'loading') return;

    const timer = setTimeout(() => {
      router.replace(status === 'authenticated' ? '/(home)' : '/welcome');
    }, MIN_SPLASH_DURATION_MS);
    return () => clearTimeout(timer);
  }, [status, router]);

  return <SplashScreen />;
}
