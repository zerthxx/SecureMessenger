import { Stack } from 'expo-router';

export default function ChatsStackLayout(): React.JSX.Element {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="[id]" options={{ animation: 'slide_from_right' }} />
      <Stack.Screen name="new" options={{ presentation: 'modal' }} />
    </Stack>
  );
}
