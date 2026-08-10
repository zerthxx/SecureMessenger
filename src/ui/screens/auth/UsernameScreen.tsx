import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/ui/theme';
import { AppText, Button, StepDots, TextField, TopBar } from '@/ui/components';
import { useAuth } from './AuthContext';
import { useSignup } from './SignupContext';

type AvailabilityState = 'idle' | 'checking' | 'available' | 'taken' | 'reserved' | 'invalid' | 'error';

export function UsernameScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { username, setUsername } = useSignup();
  const { checkUsername } = useAuth();
  const [status, setStatus] = useState<AvailabilityState>('idle');
  const requestId = useRef(0);

  useEffect(() => {
    const trimmed = username.trim();
    if (!trimmed) {
      setStatus('idle');
      return;
    }
    if (trimmed.length < 3) {
      setStatus('invalid');
      return;
    }

    setStatus('checking');
    const thisRequest = ++requestId.current;
    const timer = setTimeout(async () => {
      try {
        const result = await checkUsername(trimmed);
        if (requestId.current !== thisRequest) return; // a newer keystroke superseded this check
        if (result.available) {
          setStatus('available');
        } else {
          setStatus((result.reason as AvailabilityState) ?? 'invalid');
        }
      } catch {
        if (requestId.current === thisRequest) setStatus('error');
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [username, checkUsername]);

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
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
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
