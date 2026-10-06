import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/ui/theme';
import { AppText, Button, StepDots, TextField, TopBar } from '@/ui/components';
import { useAuth } from './AuthContext';
import { useSignup } from './SignupContext';
import { UsernameAvailabilityChecker, type AvailabilityState } from './usernameAvailability';

export function UsernameScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { username, setUsername } = useSignup();
  const { checkUsername } = useAuth();
  const [status, setStatus] = useState<AvailabilityState>('idle');

  const checkUsernameRef = useRef(checkUsername);
  checkUsernameRef.current = checkUsername;
  const checkerRef = useRef<UsernameAvailabilityChecker | null>(null);
  useEffect(() => {
    const checker = new UsernameAvailabilityChecker((name) => checkUsernameRef.current(name), setStatus);
    checkerRef.current = checker;
    return () => checker.dispose();
  }, []);
  useEffect(() => {
    checkerRef.current?.update(username);
  }, [username]);
  // The screen stays mounted under the password steps; coming back to it
  // (e.g. after the name was taken meanwhile) must not show an old answer.
  useFocusEffect(
    useCallback(() => {
      checkerRef.current?.recheck();
    }, []),
  );

  const helper: Record<AvailabilityState, { text?: string; icon?: keyof typeof Ionicons.glyphMap; tone?: 'secondary' | 'danger' }> = {
    idle: { text: 'At least 3 characters: lowercase letters, numbers, underscore.' },
    invalid: { text: 'Use 3-20 characters: lowercase letters, numbers, underscore.', tone: 'danger' },
    checking: { text: 'Checking availability…' },
    available: { text: 'Available', icon: 'checkmark-circle', tone: 'secondary' },
    taken: { text: 'Already taken — try another.', icon: 'close-circle', tone: 'danger' },
    reserved: { text: 'That username is reserved.', icon: 'close-circle', tone: 'danger' },
    error: { text: "Couldn't check availability — try again.", tone: 'danger' },
  };

  return (
    <KeyboardAvoidingView style={styles.flex} behavior="padding">
      <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
        <TopBar title="Choose a username" onBack={() => router.back()} />
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <AppText variant="body" color="secondary">
            This is how people find you. It&apos;s never your phone number or email.
          </AppText>
          <TextField
            label="Username"
            placeholder="yourname"
            leadingIcon="at"
            autoCapitalize="none"
            autoCorrect={false}
            value={username}
            onChangeText={setUsername}
            errorText={status !== 'idle' && status !== 'checking' && status !== 'available' ? helper[status].text : undefined}
            helperText={status === 'idle' || status === 'checking' || status === 'available' ? helper[status].text : undefined}
          />
          {status === 'error' ? (
            <Button label="Try again" variant="secondary" onPress={() => checkerRef.current?.recheck()} />
          ) : null}
          <Button
            label="Continue"
            size="lg"
            fullWidth
            disabled={status !== 'available'}
            onPress={() => router.push('/(auth)/password')}
          />
          <StepDots total={6} current={1} />
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 32,
    gap: 20,
  },
});
