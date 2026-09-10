import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useTheme } from '@/ui/theme';
import { AppText, Button, StepDots, TextField, TopBar } from '@/ui/components';
import { useSignup } from './SignupContext';

function pickTwoIndexes(length: number): [number, number] {
  // Guard against length < 2: with a single candidate index, `second`
  // can never differ from `first`, so the loop below would spin forever.
  // This isn't just theoretical — `recoveryCode` gets reset to `[]` by
  // this screen's own `handleConfirm` right before navigating away, and
  // this function is re-invoked (via the `useMemo` below) on every
  // re-render while this screen is still mounted during that transition.
  if (length < 2) {
    return [0, 0];
  }
  const first = Math.floor(Math.random() * length);
  let second = Math.floor(Math.random() * length);
  while (second === first) {
    second = Math.floor(Math.random() * length);
  }
  return first < second ? [first, second] : [second, first];
}

export function ConfirmRecoveryCodeScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { recoveryCode, reset } = useSignup();
  const [indexA, indexB] = useMemo(() => pickTwoIndexes(recoveryCode.length), [recoveryCode.length]);
  const [answerA, setAnswerA] = useState('');
  const [answerB, setAnswerB] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = () => {
    const correctA = recoveryCode[indexA]?.toLowerCase();
    const correctB = recoveryCode[indexB]?.toLowerCase();
    if (answerA.trim().toLowerCase() !== correctA || answerB.trim().toLowerCase() !== correctB) {
      setError('Those words don’t match your recovery code.');
      return;
    }
    setError(null);
    // Navigate first: `reset()` clears `recoveryCode` to `[]`, which
    // re-renders every consumer of SignupContext — including this
    // still-mounted screen — before the route transition finishes.
    router.replace('/(home)');
    reset();
  };

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
        <TopBar title="Confirm your code" onBack={() => router.back()} />
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <AppText variant="body" color="secondary">
            Enter the words from your recovery code to confirm you saved it.
          </AppText>
          <TextField
            label={`Word #${indexA + 1}`}
            autoCapitalize="none"
            autoCorrect={false}
            value={answerA}
            onChangeText={(text) => {
              setAnswerA(text);
              setError(null);
            }}
          />
          <TextField
            label={`Word #${indexB + 1}`}
            autoCapitalize="none"
            autoCorrect={false}
            value={answerB}
            onChangeText={(text) => {
              setAnswerB(text);
              setError(null);
            }}
            errorText={error ?? undefined}
          />
          <Button label="Confirm and finish" size="lg" fullWidth onPress={handleConfirm} />
          <StepDots total={6} current={5} />
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
