import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import type { Message } from '@/domain/entities';
import { getApiErrorMessage } from '@/infrastructure/network/trpcClient';
import { useTheme } from '@/ui/theme';
import { EmptyState, LoadingState, MessageBubble, MessageComposer, TopBar } from '@/ui/components';
import { useAuth } from '@/ui/screens/auth/AuthContext';
import { useChat } from './ChatContext';

const POLL_MS = 3000;

export function ConversationScreen(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const theme = useTheme();
  const { deviceId } = useAuth();
  const { conversations, getMessages, pollConversation, sendChatMessage, retryMessage } = useChat();
  const [loaded, setLoaded] = useState(false);
  const listRef = useRef<FlatList<Message>>(null);

  const conversation = useMemo(() => conversations.find((c) => c.id === id), [conversations, id]);
  const messages = id ? getMessages(id) : [];
  // FlatList is `inverted` so new messages stay pinned to the bottom
  // without manual scroll management — inverted expects newest-first.
  const inverted = useMemo(() => [...messages].reverse(), [messages]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      await pollConversation(id);
      if (!cancelled) setLoaded(true);
    })();
    const interval = setInterval(() => pollConversation(id), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handleSend(text: string) {
    if (!id) return;
    try {
      await sendChatMessage(id, text);
    } catch (err) {
      Alert.alert('Could not send message', getApiErrorMessage(err));
    }
  }

  async function handleRetry(messageId: string) {
    if (!id) return;
    await retryMessage(id, messageId);
  }

  if (!id) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <TopBar title="Chat" onBack={() => router.back()} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
    >
      <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
        <TopBar
          title={conversation?.otherDisplayName ?? 'Chat'}
          subtitle={conversation?.groupJoined ? 'Encrypted' : 'Setting up encryption…'}
          onBack={() => router.back()}
        />
        {!loaded ? (
          <LoadingState rows={5} />
        ) : messages.length === 0 ? (
          <View style={styles.emptyWrap}>
            <EmptyState
              icon="chatbubble-ellipses-outline"
              title="No messages yet"
              message={conversation?.groupJoined ? 'Say hello — messages are end-to-end encrypted.' : 'Waiting for encryption to finish setting up.'}
            />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={inverted}
            inverted
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.listContent}
            renderItem={({ item }) => (
              <MessageBubble
                message={item}
                isOwn={item.senderDeviceId === deviceId}
                onRetry={item.status === 'failed' ? () => handleRetry(item.id) : undefined}
              />
            )}
            showsVerticalScrollIndicator={false}
          />
        )}
        <MessageComposer disabled={!conversation?.groupJoined} onSend={handleSend} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  listContent: {
    paddingVertical: 12,
  },
  emptyWrap: {
    flex: 1,
    justifyContent: 'center',
  },
});
