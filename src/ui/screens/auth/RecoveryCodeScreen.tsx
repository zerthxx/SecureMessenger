import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useTheme } from '@/ui/theme';
import { AppText, Button, Card, IconButton, StepDots, TopBar } from '@/ui/components';
import { useSignup } from './SignupContext';

export function RecoveryCodeScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { recoveryCode } = useSignup();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
      <TopBar title="Save your recovery code" />
      <ScrollView contentContainerStyle={styles.content}>
        <AppText variant="body" color="secondary">
          This is the only way to recover your account if you forget your password. Write it down
          and keep it somewhere safe — we can&apos;t show it to you again.
        </AppText>

        <Card style={styles.codeCard}>
          <View style={styles.grid}>
            {recoveryCode.map((word, index) => (
              <View key={word + index} style={styles.wordRow}>
                <AppText variant="caption" color="tertiary" style={styles.wordIndex}>
                  {index + 1}
                </AppText>
                <AppText variant="bodyMedium">{word}</AppText>
              </View>
            ))}
          </View>
        </Card>

        <View style={styles.copyRow}>
          <IconButton
            name={copied ? 'checkmark' : 'copy-outline'}
            accessibilityLabel="Copy recovery code"
            variant="filled"
            onPress={handleCopy}
          />
          <AppText variant="body" color={copied ? 'accent' : 'secondary'}>
            {copied ? 'Copied to clipboard' : 'Tap to copy'}
          </AppText>
        </View>

        <Button label="I've saved my code" size="lg" fullWidth onPress={() => router.push('/(auth)/confirm-recovery-code')} />
        <StepDots total={6} current={4} />
      </ScrollView>
    </View>
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
  codeCard: {
    paddingVertical: 20,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  wordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '50%',
    paddingVertical: 8,
    gap: 8,
  },
  wordIndex: {
    width: 20,
  },
  copyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    alignSelf: 'center',
  },
});
