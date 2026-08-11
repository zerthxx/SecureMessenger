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
      <Tabs.Screen
        name="chats"
        options={{ title: 'Chats', tabBarIcon: tabIcon('chatbubble-outline', 'chatbubble') }}
        listeners={({ navigation }) => ({
          // Without this, switching away from the Chats tab while inside
          // a conversation (chats/[id]) and back preserves that nested
          // stack's position by default — the bottom "Chats" tab would
          // silently reopen whatever conversation was last viewed instead
          // of the conversation list.
          //
          // `e.preventDefault()` is required, not optional: without it,
          // React Navigation's own default tab-press handling (which
          // restores this tab's last-visited screen) races the explicit
          // `navigate` call below. On-device testing showed the explicit
          // call alone works when re-pressing "Chats" while already on
          // it, but NOT when switching to it from a different tab
          // (Home → Chats) — the default restore-last-position behavior
          // won that race and reopened the conversation anyway.
          // Preventing the default first makes this the only navigation
          // that happens, for both cases. (An even earlier attempt used
          // the built-in `popToTopOnBlur` screen option instead —
          // confirmed via on-device testing to silently break ALL
          // navigation into this tab, not just fix the reported issue;
          // reverted.)
          tabPress: (e) => {
            e.preventDefault();
            navigation.navigate('chats', { screen: 'index' });
          },
        })}
      />
      <Tabs.Screen name="stories" options={{ title: 'Stories', tabBarIcon: tabIcon('sparkles-outline', 'sparkles') }} />
      <Tabs.Screen name="groups" options={{ title: 'Groups', tabBarIcon: tabIcon('people-outline', 'people') }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: tabIcon('person-outline', 'person') }} />
    </Tabs>
  );
}
