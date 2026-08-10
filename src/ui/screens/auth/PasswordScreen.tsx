import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useTheme } from '@/ui/theme';
import { AppText, Button, PasswordStrengthMeter, StepDots, TextField, TopBar } from '@/ui/components';
import { useSignup } from './SignupContext';

export function PasswordScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { password, setPassword } = useSignup();
  const [hidden, setHidden] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const handleContinue = () => {
    if (password.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    setError(null);
    router.push('/(auth)/confirm-password');
  };

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
        <TopBar title="Create a password" onBack={() => router.back()} />
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <AppText variant="body" color="secondary">
            Make it something only you know. It never leaves your device unencrypted.
          </AppText>
          <TextField
            label="Password"
            placeholder="Enter a password"
            leadingIcon="lock-closed-outline"
            trailingIcon={hidden ? 'eye-outline' : 'eye-off-outline'}
            onTrailingIconPress={() => setHidden((v) => !v)}
            secureTextEntry={hidden}
            value={password}
            onChangeText={(text) => {
              setPassword(text);
              setError(null);
            }}
            errorText={error ?? undefined}
          />
          <PasswordStrengthMeter password={password} />
          <Button label="Continue" size="lg" fullWidth onPress={handleContinue} />
          <StepDots total={6} current={2} />
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
