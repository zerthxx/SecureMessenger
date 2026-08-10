import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useTheme } from '@/ui/theme';
import { AppText, Button, StepDots, TextField, TopBar } from '@/ui/components';
import { useAuth } from './AuthContext';
import { getApiErrorMessage } from '@/infrastructure/network/trpcClient';
import { useSignup } from './SignupContext';

export function ConfirmPasswordScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { displayName, username, password, setRecoveryCode } = useSignup();
  const { register } = useAuth();
  const [confirm, setConfirm] = useState('');
  const [hidden, setHidden] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleContinue = async () => {
    if (confirm !== password) {
      setError("Passwords don't match.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const { recoveryCode } = await register({ username, displayName, password });
      setRecoveryCode(recoveryCode);
      router.push('/(auth)/recovery-code');
    } catch (err) {
      setError(getApiErrorMessage(err, 'Could not create your account. Please try again.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
        <TopBar title="Confirm your password" onBack={() => router.back()} />
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <AppText variant="body" color="secondary">
            Type it once more to make sure it&apos;s right.
          </AppText>
          <TextField
            label="Confirm password"
            placeholder="Re-enter your password"
            leadingIcon="lock-closed-outline"
            trailingIcon={hidden ? 'eye-outline' : 'eye-off-outline'}
            onTrailingIconPress={() => setHidden((v) => !v)}
            secureTextEntry={hidden}
            value={confirm}
            onChangeText={(text) => {
              setConfirm(text);
              setError(null);
            }}
            errorText={error ?? undefined}
          />
          <Button label="Continue" size="lg" fullWidth loading={loading} onPress={handleContinue} />
          <StepDots total={6} current={3} />
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
