import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/ui/theme';
import { AppText, Button, PasswordStrengthMeter, TextField, TopBar } from '@/ui/components';
import { getApiErrorMessage } from '@/infrastructure/network/trpcClient';
import { useAuth } from './AuthContext';

const MIN_PASSWORD_LENGTH = 8; // server: auth.changePassword passwordField
const MAX_PASSWORD_LENGTH = 200;

type FieldErrors = { current?: string; next?: string; confirm?: string; form?: string };

export function ChangePasswordScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { changePassword } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [hidden, setHidden] = useState(true);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const goBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/settings');
    }
  };

  const validate = (): FieldErrors => {
    const found: FieldErrors = {};
    if (!current) found.current = 'Enter your current password.';
    if (next.length < MIN_PASSWORD_LENGTH) {
      found.next = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    } else if (next.length > MAX_PASSWORD_LENGTH) {
      found.next = `Use ${MAX_PASSWORD_LENGTH} characters or fewer.`;
    } else if (current && next === current) {
      found.next = 'Choose a password different from your current one.';
    }
    if (!found.next && confirm !== next) found.confirm = "Passwords don't match.";
    return found;
  };

  const handleSave = async () => {
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setLoading(true);
    try {
      await changePassword({ currentPassword: current, newPassword: next });
      setSuccess(true);
      setTimeout(goBack, 1800);
    } catch (err) {
      const message = getApiErrorMessage(err, 'Could not update your password. Please try again.');
      setErrors(message === 'Current password is incorrect.' ? { current: message } : { form: message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
        <TopBar title="Change password" onBack={goBack} />
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {success ? (
            <View style={styles.success}>
              <Ionicons name="checkmark-circle" size={40} color={theme.colors.success} />
              <AppText variant="bodyMedium" style={{ color: theme.colors.success }}>
                Password updated
              </AppText>
              <AppText variant="body" color="secondary" style={styles.successDetail}>
                Any other devices signed in to your account have been signed out.
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
                autoCapitalize="none"
                value={current}
                onChangeText={(text) => {
                  setCurrent(text);
                  setErrors((e) => ({ ...e, current: undefined, form: undefined }));
                }}
                errorText={errors.current}
              />
              <TextField
                label="New password"
                leadingIcon="lock-closed-outline"
                secureTextEntry={hidden}
                autoCapitalize="none"
                value={next}
                onChangeText={(text) => {
                  setNext(text);
                  setErrors((e) => ({ ...e, next: undefined, confirm: undefined, form: undefined }));
                }}
                errorText={errors.next}
              />
              <PasswordStrengthMeter password={next} />
              <TextField
                label="Confirm new password"
                leadingIcon="lock-closed-outline"
                secureTextEntry={hidden}
                autoCapitalize="none"
                value={confirm}
                onChangeText={(text) => {
                  setConfirm(text);
                  setErrors((e) => ({ ...e, confirm: undefined, form: undefined }));
                }}
                errorText={errors.confirm}
              />
              {errors.form ? (
                <AppText variant="body" color="danger">
                  {errors.form}
                </AppText>
              ) : null}
              <Button label="Change password" size="lg" fullWidth loading={loading} onPress={handleSave} />
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
  successDetail: {
    textAlign: 'center',
  },
});
