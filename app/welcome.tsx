import { useRouter } from 'expo-router';

import { WelcomeScreen } from '@/ui/screens';

export default function Welcome(): React.JSX.Element {
  const router = useRouter();
  return (
    <WelcomeScreen
      onCreateAccount={() => router.push('/(auth)/create-account')}
      onLogIn={() => router.push('/(auth)/login')}
    />
  );
}
