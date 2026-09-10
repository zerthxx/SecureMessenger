import { useCallback, useMemo, useRef } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter, type Href } from 'expo-router';

import type { Chat, Conversation } from '@/domain/entities';
import { useAuth } from './auth';
import { useChat } from '@/ui/screens/chat';
import { UpdateBanner } from '@/ui/screens/update';
import { useTheme } from '@/ui/theme';
import { AppText, Card, ChatRow, Divider, IconButton } from '@/ui/components';

// See canNavigateRef's doc comment in HomeScreen below — 400ms
// comfortably covers the native slide transition duration (typically
// ~250-300ms) with margin.
const NAV_SETTLE_MS = 400;

function toChat(conversation: Conversation): Chat {
  return {
    id: conversation.id,
    participantName: conversation.otherDisplayName,
    participantOnline: false,
    lastMessage: conversation.lastMessagePreview ?? (conversation.groupJoined ? 'No messages yet' : 'Setting up encryption…'),
    timestampLabel: '',
    unreadCount: 0,
    pinned: false,
    muted: false,
    isGroup: false,
  };
}

export function HomeScreen(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const { conversations } = useChat();

  const recentChats = useMemo(() => conversations.slice(0, 4).map(toChat), [conversations]);

  /**
   * A row tapped within ~NAV_SETTLE_MS of this screen regaining focus
   * (e.g. tapping "back" out of a conversation, then immediately tapping
   * a different row before the native slide-back transition finishes)
   * can have its touch misrouted to the wrong row's `onPress` closure
   * while the outgoing screen is still animating out — a react-native-
   * screens/native-stack transition race, not a routing or data bug (a
   * conversation opened via a raw href always opens the correct one;
   * only a tap landing mid-transition can target the wrong row).
   * Ignoring taps until the transition has had time to settle closes
   * that window. Same fix as ChatsScreen's own recent-chats list.
   */
  const canNavigateRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      canNavigateRef.current = false;
      const timer = setTimeout(() => {
        canNavigateRef.current = true;
      }, NAV_SETTLE_MS);
      return () => clearTimeout(timer);
    }, []),
  );

  const quickActions: { icon: keyof typeof Ionicons.glyphMap; label: string; accessibilityLabel: string; onPress: () => void }[] = [
    {
      icon: 'create-outline',
      label: 'New chat',
      accessibilityLabel: 'Start a new chat',
      onPress: () => router.push('/(home)/chats/new' as unknown as Href),
    },
    {
      icon: 'people-outline',
      label: 'New group',
      accessibilityLabel: 'Create a new group',
      onPress: () => router.push('/(home)/groups' as unknown as Href),
    },
    {
      icon: 'qr-code-outline',
      label: 'Scan code',
      accessibilityLabel: 'Scan a QR code',
      onPress: () =>
        Alert.alert(
          'Scan code unavailable',
          'QR code scanning needs camera access that this build does not yet include. This will be enabled in a future update.',
        ),
    },
  ];

  return (
    <ScrollView
      style={{ backgroundColor: theme.colors.background }}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + theme.spacing.md }]}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.header}>
        <View>
          <AppText variant="body" color="secondary">
            Good to see you
          </AppText>
          <AppText variant="headline">{(user?.displayName ?? '').split(' ')[0]}</AppText>
        </View>
        <IconButton
          name="person-circle-outline"
          size={30}
          accessibilityLabel="Open profile"
          onPress={() => router.push('/(home)/profile')}
        />
      </View>

      <UpdateBanner />

      <View style={styles.quickActions}>
        {quickActions.map((action) => (
          <Pressable
            key={action.label}
            style={styles.quickActionCard}
            accessibilityRole="button"
            accessibilityLabel={action.accessibilityLabel}
            onPress={action.onPress}
          >
            <Card elevationLevel={1} style={styles.quickActionCardInner}>
              <View style={[styles.quickActionIcon, { backgroundColor: theme.colors.primaryMuted }]}>
                <Ionicons name={action.icon} size={20} color={theme.colors.primary} />
              </View>
              <AppText variant="caption" style={styles.quickActionLabel}>
                {action.label}
              </AppText>
            </Card>
          </Pressable>
        ))}
      </View>

      <View style={styles.sectionHeader}>
        <AppText variant="title">Recent chats</AppText>
        <AppText variant="bodyMedium" color="accent" onPress={() => router.push('/(home)/chats')}>
          See all
        </AppText>
      </View>

      {recentChats.length > 0 ? (
        <Card padded={false} style={styles.chatCard}>
          {recentChats.map((chat, index) => (
            <View key={chat.id}>
              <View style={styles.chatRowPadding}>
                <ChatRow
                  chat={chat}
                  onPress={() => {
                    if (!canNavigateRef.current) return;
                    router.push({ pathname: '/(home)/chats/[id]', params: { id: chat.id } } as unknown as Href);
                  }}
                />
              </View>
              {index < recentChats.length - 1 ? <Divider inset={72} /> : null}
            </View>
          ))}
        </Card>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 20,
    paddingBottom: 32,
    gap: 24,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  quickActions: {
    flexDirection: 'row',
    gap: 12,
  },
  quickActionCard: {
    flex: 1,
  },
  quickActionCardInner: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 16,
  },
  quickActionIcon: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickActionLabel: {
    textAlign: 'center',
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: -12,
  },
  chatCard: {
    paddingVertical: 4,
  },
  chatRowPadding: {
    paddingHorizontal: 16,
  },
});
