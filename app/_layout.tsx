import 'react-native-gesture-handler';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ThemeProvider, useTheme } from '@/ui/theme';
import { AuthProvider, ChatProvider, UpdateDialog, UpdateIndicator, UpdateProvider } from '@/ui/screens';

function ThemedStatusBar(): React.JSX.Element {
  const theme = useTheme();
  return <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />;
}

function RootNavigator(): React.JSX.Element {
  const theme = useTheme();

  return (
    <>
      <ThemedStatusBar />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.colors.background } }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="welcome" />
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(home)" />
        <Stack.Screen name="settings" options={{ presentation: 'card', animation: 'slide_from_right' }} />
        <Stack.Screen name="change-password" options={{ presentation: 'card', animation: 'slide_from_right' }} />
      </Stack>
    </>
  );
}

export default function RootLayout(): React.JSX.Element {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <AuthProvider>
            <ChatProvider>
              <UpdateProvider>
                <RootNavigator />
                <UpdateIndicator />
                <UpdateDialog />
              </UpdateProvider>
            </ChatProvider>
          </AuthProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
