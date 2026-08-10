import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, type Href } from 'expo-router';

import { mockCurrentUser, mockStories } from '@/data/mock';
import type { Chat, Conversation } from '@/domain/entities';
import { useChat } from '@/ui/screens/chat';
import { useTheme } from '@/ui/theme';
import { AppText, Card, ChatRow, Divider, IconButton, StoryRing } from '@/ui/components';

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

const quickActions: { icon: keyof typeof Ionicons.glyphMap; label: string }[] = [
  { icon: 'create-outline', label: 'New chat' },
  { icon: 'people-outline', label: 'New group' },
  { icon: 'qr-code-outline', label: 'Scan code' },
];

export function HomeScreen(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { conversations } = useChat();

  const recentChats = useMemo(() => conversations.slice(0, 4).map(toChat), [conversations]);

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
          <AppText variant="headline">{mockCurrentUser.name.split(' ')[0]}</AppText>
        </View>
        <IconButton
          name="person-circle-outline"
          size={30}
          accessibilityLabel="Open profile"
          onPress={() => router.push('/(home)/profile')}
        />
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.storyTray} contentContainerStyle={styles.storyTrayContent}>
        {mockStories.map((story) => (
          <View key={story.id} style={styles.storyItem}>
            <StoryRing name={story.authorName} seen={story.seen} />
            <AppText variant="caption" color="secondary" numberOfLines={1} style={styles.storyLabel}>
              {story.authorName === 'Your Story' ? 'Add' : story.authorName.split(' ')[0]}
            </AppText>
          </View>
        ))}
      </ScrollView>

      <View style={styles.quickActions}>
        {quickActions.map((action) => {
          const card = (
            <Card elevationLevel={1} style={styles.quickActionCardInner}>
              <View style={[styles.quickActionIcon, { backgroundColor: theme.colors.primaryMuted }]}>
                <Ionicons name={action.icon} size={20} color={theme.colors.primary} />
              </View>
              <AppText variant="caption" style={styles.quickActionLabel}>
                {action.label}
              </AppText>
            </Card>
          );
          if (action.label !== 'New chat') {
            return (
              <View key={action.label} style={styles.quickActionCard}>
                {card}
              </View>
            );
          }
          return (
            <Pressable
              key={action.label}
              style={styles.quickActionCard}
              accessibilityRole="button"
              accessibilityLabel="Start a new chat"
              onPress={() => router.push('/(home)/chats/new' as unknown as Href)}
            >
              {card}
            </Pressable>
          );
        })}
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
                  onPress={() => router.push({ pathname: '/(home)/chats/[id]', params: { id: chat.id } } as unknown as Href)}
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
  storyTray: {
    marginHorizontal: -20,
  },
  storyTrayContent: {
    paddingHorizontal: 20,
    gap: 16,
  },
  storyItem: {
    alignItems: 'center',
    width: 64,
    gap: 6,
  },
  storyLabel: {
    maxWidth: 64,
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
