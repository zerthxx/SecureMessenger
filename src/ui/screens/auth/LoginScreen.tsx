import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useTheme } from '@/ui/theme';
import { AppText, Button, TextField, TopBar } from '@/ui/components';
import { getApiErrorMessage, useAuth } from './AuthContext';

export function LoginScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [hidePassword, setHidePassword] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!username.trim() || !password.trim()) {
      setError('Enter your username and password.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await login({ username: username.trim(), password });
      router.replace('/(home)');
    } catch (err) {
      setError(getApiErrorMessage(err, 'Incorrect username or password.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
        <TopBar title="Log in" onBack={() => router.back()} />
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <AppText variant="body" color="secondary">
            Welcome back. Enter your details to continue.
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
              setError(null);
            }}
          />
          <TextField
            label="Password"
            placeholder="Enter your password"
            leadingIcon="lock-closed-outline"
            trailingIcon={hidePassword ? 'eye-outline' : 'eye-off-outline'}
            onTrailingIconPress={() => setHidePassword((v) => !v)}
            secureTextEntry={hidePassword}
            value={password}
            onChangeText={(text) => {
              setPassword(text);
              setError(null);
            }}
            errorText={error ?? undefined}
          />
          <AppText
            variant="bodyMedium"
            color="accent"
            style={styles.forgot}
            onPress={() => router.push('/(auth)/forgot-password')}
          >
            Forgot password?
          </AppText>
          <Button label="Log in" size="lg" fullWidth loading={loading} onPress={handleLogin} />
          <View style={styles.footer}>
            <AppText variant="body" color="secondary">
              Don&apos;t have an account?{' '}
            </AppText>
            <AppText variant="bodyMedium" color="accent" onPress={() => router.replace('/(auth)/create-account')}>
              Create one
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
    gap: 16,
  },
  forgot: {
    alignSelf: 'flex-end',
    marginTop: -8,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 8,
  },
});
