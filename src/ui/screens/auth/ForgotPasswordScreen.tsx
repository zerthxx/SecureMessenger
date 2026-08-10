import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/ui/theme';
import { AppText, Button, PasswordStrengthMeter, TextField, TopBar } from '@/ui/components';
import { getApiErrorMessage } from '@/infrastructure/network/trpcClient';
import { useAuth } from './AuthContext';

type Step = 'code' | 'newPassword' | 'success';

export function ForgotPasswordScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { verifyRecoveryCode, resetPassword } = useAuth();
  const [step, setStep] = useState<Step>('code');
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [recoveryToken, setRecoveryToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(true);
  const [loading, setLoading] = useState(false);

  const handleVerifyCode = async () => {
    if (!username.trim()) {
      setCodeError('Enter your username.');
      return;
    }
    const words = code.trim().split(/\s+/).filter(Boolean);
    if (words.length < 6) {
      setCodeError('Enter your full recovery code.');
      return;
    }
    setCodeError(null);
    setLoading(true);
    try {
      const result = await verifyRecoveryCode({ username: username.trim(), recoveryCode: code });
      setRecoveryToken(result.recoveryToken);
      setStep('newPassword');
    } catch (err) {
      setCodeError(getApiErrorMessage(err, 'That recovery code is not valid.'));
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async () => {
    if (password.length < 8) {
      setPasswordError('Use at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setPasswordError("Passwords don't match.");
      return;
    }
    if (!recoveryToken) {
      setPasswordError('Your session expired — start over.');
      setStep('code');
      return;
    }
    setPasswordError(null);
    setLoading(true);
    try {
      await resetPassword({ recoveryToken, newPassword: password });
      setStep('success');
    } catch (err) {
      setPasswordError(getApiErrorMessage(err, 'Could not reset your password. Please try again.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
        <TopBar title="Reset your password" onBack={() => router.back()} />
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {step === 'code' ? (
            <>
              <AppText variant="body" color="secondary">
                Enter your username and recovery code to verify it&apos;s you.
              </AppText>
              <TextField
                label="Username"
                placeholder="@yourname"
                leadingIcon="at"
                autoCapitalize="none"
                autoCorrect={false}
                value={username}
                onChangeText={(text) => {
                  setUsername(text);
                  setCodeError(null);
                }}
              />
              <TextField
                label="Recovery code"
                placeholder="word1 word2 word3 …"
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                value={code}
                onChangeText={(text) => {
                  setCode(text);
                  setCodeError(null);
                }}
                errorText={codeError ?? undefined}
              />
              <Button label="Verify code" size="lg" fullWidth loading={loading} onPress={handleVerifyCode} />
            </>
          ) : null}

          {step === 'newPassword' ? (
            <>
              <AppText variant="body" color="secondary">
                Code verified. Choose a new password.
              </AppText>
              <TextField
                label="New password"
                leadingIcon="lock-closed-outline"
                trailingIcon={hidden ? 'eye-outline' : 'eye-off-outline'}
                onTrailingIconPress={() => setHidden((v) => !v)}
                secureTextEntry={hidden}
                value={password}
                onChangeText={(text) => {
                  setPassword(text);
                  setPasswordError(null);
                }}
              />
              <PasswordStrengthMeter password={password} />
              <TextField
                label="Confirm new password"
                leadingIcon="lock-closed-outline"
                secureTextEntry={hidden}
                value={confirm}
                onChangeText={(text) => {
                  setConfirm(text);
                  setPasswordError(null);
                }}
                errorText={passwordError ?? undefined}
              />
              <Button label="Reset password" size="lg" fullWidth loading={loading} onPress={handleResetPassword} />
            </>
          ) : null}

          {step === 'success' ? (
            <View style={styles.success}>
              <View style={[styles.successIcon, { backgroundColor: theme.colors.primaryMuted }]}>
                <Ionicons name="checkmark-circle" size={40} color={theme.colors.primary} />
              </View>
              <AppText variant="title" style={styles.successTitle}>
                Password reset
              </AppText>
              <AppText variant="body" color="secondary" style={styles.successBody}>
                You can now log in with your new password. For your security, every device was
                signed out — including this recovery session.
              </AppText>
              <Button label="Back to login" size="lg" fullWidth onPress={() => router.replace('/(auth)/login')} />
            </View>
          ) : null}
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
  success: {
    alignItems: 'center',
    gap: 12,
    paddingTop: 24,
  },
  successIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  successTitle: {
    marginTop: 4,
  },
  successBody: {
    textAlign: 'center',
    marginBottom: 12,
  },
});
