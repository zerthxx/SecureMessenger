import type { ColorValue } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router/js-tabs';

import { BottomNav } from '@/ui/components';

// No read-receipt/unread tracking in Phase 6's scope (see the Phase 6
// report's remaining limitations) — the Chats tab has no badge count
// until that lands, rather than showing a number that's always wrong.

function tabIcon(outline: keyof typeof Ionicons.glyphMap, filled: keyof typeof Ionicons.glyphMap) {
  return ({ focused, color }: { focused: boolean; color: ColorValue }) => (
    <Ionicons name={focused ? filled : outline} size={24} color={color as string} />
  );
}

export default function HomeLayout(): React.JSX.Element {
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <BottomNav {...props} />}>
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: tabIcon('home-outline', 'home') }} />
      <Tabs.Screen name="chats" options={{ title: 'Chats', tabBarIcon: tabIcon('chatbubble-outline', 'chatbubble') }} />
      <Tabs.Screen name="stories" options={{ title: 'Stories', tabBarIcon: tabIcon('sparkles-outline', 'sparkles') }} />
      <Tabs.Screen name="groups" options={{ title: 'Groups', tabBarIcon: tabIcon('people-outline', 'people') }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: tabIcon('person-outline', 'person') }} />
    </Tabs>
  );
}
