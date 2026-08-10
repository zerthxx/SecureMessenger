import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useTheme } from '@/ui/theme';
import { AppText, BrandMark, Button, StepDots, TextField, TopBar } from '@/ui/components';
import { useSignup } from './SignupContext';

export function CreateAccountScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { displayName, setDisplayName } = useSignup();
  const [error, setError] = useState<string | null>(null);

  const handleContinue = () => {
    if (!displayName.trim()) {
      setError('Tell us what to call you.');
      return;
    }
    setError(null);
    router.push('/(auth)/username');
  };

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
        <TopBar title="Create account" onBack={() => router.back()} />
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.hero}>
            <BrandMark size={48} />
            <AppText variant="headline" style={styles.title}>
              What should we call you?
            </AppText>
            <AppText variant="body" color="secondary">
              This is just a display name — you&apos;ll pick a private username next.
            </AppText>
          </View>
          <TextField
            label="Display name"
            placeholder="Jordan Ellis"
            autoCapitalize="words"
            value={displayName}
            onChangeText={(text) => {
              setDisplayName(text);
              setError(null);
            }}
            errorText={error ?? undefined}
          />
          <Button label="Continue" size="lg" fullWidth onPress={handleContinue} />
          <StepDots total={6} current={0} />
          <View style={styles.footer}>
            <AppText variant="body" color="secondary">
              Already have an account?{' '}
            </AppText>
            <AppText variant="bodyMedium" color="accent" onPress={() => router.replace('/(auth)/login')}>
              Log in
            </AppText>
          </View>
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
  hero: {
    gap: 10,
  },
  title: {
    marginTop: 4,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
});
