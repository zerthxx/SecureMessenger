import { Stack } from 'expo-router';

import { SignupProvider } from '@/ui/screens';

export default function AuthLayout(): React.JSX.Element {
  return (
    <SignupProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </SignupProvider>
  );
}
