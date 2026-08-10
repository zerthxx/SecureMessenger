import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/ui/theme';
import { AppText, Button, PasswordStrengthMeter, TextField, TopBar } from '@/ui/components';
import { getApiErrorMessage } from '@/infrastructure/network/trpcClient';
import { useAuth } from './AuthContext';

export function ChangePasswordScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { changePassword } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [hidden, setHidden] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSave = async () => {
    if (!current.trim()) {
      setError('Enter your current password.');
      return;
    }
    if (next.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (next !== confirm) {
      setError("New passwords don't match.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await changePassword({ currentPassword: current, newPassword: next });
      setSuccess(true);
      setTimeout(() => router.back(), 1000);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Could not update your password.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
        <TopBar title="Change passphrase" onBack={() => router.back()} />
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {success ? (
            <View style={styles.success}>
              <Ionicons name="checkmark-circle" size={40} color={theme.colors.success} />
              <AppText variant="bodyMedium" style={{ color: theme.colors.success }}>
                Passphrase updated
              </AppText>
            </View>
          ) : (
            <>
              <TextField
                label="Current password"
                leadingIcon="lock-closed-outline"
                trailingIcon={hidden ? 'eye-outline' : 'eye-off-outline'}
                onTrailingIconPress={() => setHidden((v) => !v)}
                secureTextEntry={hidden}
                value={current}
                onChangeText={(text) => {
                  setCurrent(text);
                  setError(null);
                }}
              />
              <TextField
                label="New password"
                leadingIcon="lock-closed-outline"
                secureTextEntry={hidden}
                value={next}
                onChangeText={(text) => {
                  setNext(text);
                  setError(null);
                }}
              />
              <PasswordStrengthMeter password={next} />
              <TextField
                label="Confirm new password"
                leadingIcon="lock-closed-outline"
                secureTextEntry={hidden}
                value={confirm}
                onChangeText={(text) => {
                  setConfirm(text);
                  setError(null);
                }}
                errorText={error ?? undefined}
              />
              <Button label="Save changes" size="lg" fullWidth loading={loading} onPress={handleSave} />
            </>
          )}
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
    gap: 10,
    paddingTop: 40,
  },
});
