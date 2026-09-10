import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, FlatList, KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
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
  const {
    conversations,
    e2eeError,
    retryE2eeSetup,
    getMessages,
    pollConversation,
    sendChatMessage,
    sendVoiceMessage,
    downloadVoiceMessage,
    retryMessage,
  } = useChat();
  const [retrying, setRetrying] = useState(false);

  async function handleRetryE2eeSetup() {
    setRetrying(true);
    try {
      await retryE2eeSetup();
    } finally {
      setRetrying(false);
    }
  }
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

    // Audit fix: this previously polled every POLL_MS unconditionally,
    // including while backgrounded — the single clearest battery/network
    // cost found in the client audit, compounding with ChatContext's own
    // conversation-list poll. Paused while AppState isn't 'active', with
    // an immediate refresh on returning to foreground so messages aren't
    // stale on resume.
    let interval: ReturnType<typeof setInterval> | null = null;
    const startInterval = () => {
      if (interval) return;
      interval = setInterval(() => pollConversation(id), POLL_MS);
    };
    const stopInterval = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    if (AppState.currentState === 'active') startInterval();

    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        pollConversation(id);
        startInterval();
      } else {
        stopInterval();
      }
    });

    return () => {
      cancelled = true;
      stopInterval();
      subscription.remove();
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

  async function handleSendVoice(uri: string, durationMs: number) {
    if (!id) return;
    try {
      await sendVoiceMessage(id, uri, durationMs);
    } catch (err) {
      Alert.alert('Could not send voice message', getApiErrorMessage(err));
    }
  }

  async function handleRetry(messageId: string) {
    if (!id) return;
    await retryMessage(id, messageId);
  }

  async function handleDownloadAudio(messageId: string) {
    if (!id) return;
    await downloadVoiceMessage(id, messageId);
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
          subtitle={conversation?.groupJoined ? 'Encrypted' : e2eeError ? 'Encryption unavailable' : 'Setting up encryption…'}
          onBack={() => router.back()}
        />
        {!loaded ? (
          <LoadingState rows={5} />
        ) : messages.length === 0 ? (
          <View style={styles.emptyWrap}>
            {!conversation?.groupJoined && e2eeError ? (
              <EmptyState
                icon="alert-circle-outline"
                title="Encrypted messaging unavailable"
                message={e2eeError}
                actionLabel={retrying ? 'Retrying…' : 'Retry'}
                onAction={retrying ? undefined : handleRetryE2eeSetup}
              />
            ) : (
              <EmptyState
                icon="chatbubble-ellipses-outline"
                title="No messages yet"
                message={conversation?.groupJoined ? 'Say hello — messages are end-to-end encrypted.' : 'Waiting for encryption to finish setting up.'}
              />
            )}
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
                onDownloadAudio={item.kind === 'voice' ? () => handleDownloadAudio(item.id) : undefined}
              />
            )}
            showsVerticalScrollIndicator={false}
          />
        )}
        <MessageComposer disabled={!conversation?.groupJoined} onSend={handleSend} onSendVoice={handleSendVoice} />
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
