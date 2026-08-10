import { useMemo, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';

import type { Chat, Conversation } from '@/domain/entities';
import { useChat } from '@/ui/screens/chat';
import { useTheme } from '@/ui/theme';
import { ChatRow, Divider, EmptyState, ErrorState, IconButton, TextField, TopBar } from '@/ui/components';

function formatTimestamp(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function toChat(conversation: Conversation): Chat {
  return {
    id: conversation.id,
    participantName: conversation.otherDisplayName,
    // No presence system in this phase's scope — see the Phase 6 report's remaining limitations.
    participantOnline: false,
    lastMessage: conversation.lastMessagePreview ?? (conversation.groupJoined ? 'No messages yet' : 'Setting up encryption…'),
    timestampLabel: formatTimestamp(conversation.lastMessageAt ?? conversation.createdAt),
    // No read-receipt/unread tracking in this phase's scope.
    unreadCount: 0,
    pinned: false,
    muted: false,
    isGroup: false,
  };
}

export function ChatsScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { conversations, e2eeError, refreshConversations } = useChat();
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const chats = useMemo(() => {
    const mapped = conversations.map(toChat);
    if (!query.trim()) return mapped;
    const needle = query.trim().toLowerCase();
    return mapped.filter((chat) => chat.participantName.toLowerCase().includes(needle));
  }, [conversations, query]);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await refreshConversations();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <TopBar
        title="Chats"
        large
        rightSlot={
          <IconButton
            name="create-outline"
            accessibilityLabel="Start a new chat"
            onPress={() => router.push('/(home)/chats/new' as unknown as Href)}
          />
        }
      />
      {e2eeError ? (
        <ErrorState title="Encrypted messaging unavailable" message={e2eeError} onRetry={refreshConversations} />
      ) : (
        <>
          <View style={styles.searchWrap}>
            <TextField placeholder="Search conversations" leadingIcon="search" value={query} onChangeText={setQuery} returnKeyType="search" />
          </View>
          <FlatList
            data={chats}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.listContent}
            refreshing={refreshing}
            onRefresh={handleRefresh}
            renderItem={({ item }) => (
              <View style={styles.rowPadding}>
                <ChatRow
                  chat={item}
                  onPress={() => router.push({ pathname: '/(home)/chats/[id]', params: { id: item.id } } as unknown as Href)}
                />
              </View>
            )}
            ItemSeparatorComponent={() => <Divider inset={80} />}
            ListEmptyComponent={
              <EmptyState
                icon="chatbubble-ellipses-outline"
                title={query ? 'No chats found' : 'No conversations yet'}
                message={query ? 'Try a different search.' : 'Tap the compose icon to start an encrypted chat.'}
                actionLabel={query ? undefined : 'New chat'}
                onAction={query ? undefined : () => router.push('/(home)/chats/new' as unknown as Href)}
              />
            }
            showsVerticalScrollIndicator={false}
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  searchWrap: {
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  listContent: {
    paddingBottom: 32,
  },
  rowPadding: {
    paddingHorizontal: 20,
  },
});
