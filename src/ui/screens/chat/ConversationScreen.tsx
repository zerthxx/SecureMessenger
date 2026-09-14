import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, AppState, FlatList, KeyboardAvoidingView, Platform, StyleSheet, View, type ListRenderItemInfo } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import type { Message } from '@/domain/entities';
import { getApiErrorMessage } from '@/infrastructure/network/trpcClient';
import { setActiveConversation } from '@/infrastructure/notifications/pushNotifications';
import { realtime } from '@/infrastructure/realtime/realtimeClient';
import { useTheme } from '@/ui/theme';
import { EmptyState, IconButton, LoadingState, MessageBubble, MessageComposer, TopBar } from '@/ui/components';
import { UserAvatar, useOpenUserProfile } from '@/ui/screens/profile';
import { useAuth } from '@/ui/screens/auth/AuthContext';
import { useCall } from '@/ui/screens/call';
import { useChat } from './ChatContext';
import { loadOlderMessages, useConversationMessages } from './conversationMessages';

const POLL_MS = 3000;
/** With the realtime socket connected, only every Nth poll runs (30 s): new messages arrive as hints instead. */
const ONLINE_POLL_EVERY = 10;

function keyExtractor(message: Message): string {
  return message.id;
}

export function ConversationScreen(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const openUserProfile = useOpenUserProfile();
  const theme = useTheme();
  const { deviceId } = useAuth();
  const {
    conversations,
    e2eeError,
    retryE2eeSetup,
    pollConversation,
    sendChatMessage,
    sendVoiceMessage,
    downloadVoiceMessage,
    retryMessage,
  } = useChat();
  const { startCall } = useCall();
  const [retrying, setRetrying] = useState(false);

  async function handleRetryE2eeSetup() {
    setRetrying(true);
    try {
      await retryE2eeSetup();
    } finally {
      setRetrying(false);
    }
  }
  const [synced, setSynced] = useState(false);

  const conversation = useMemo(() => conversations.find((c) => c.id === id), [conversations, id]);

  // Messages for the chat that's on screen shouldn't also raise notifications.
  useEffect(() => {
    if (!id) return;
    setActiveConversation(id);
    return () => setActiveConversation(null);
  }, [id]);

  // Newest first, straight from the local store: re-renders only when this
  // conversation's messages change, and already-stored messages show
  // immediately instead of waiting for the first network sync.
  const { messages, hasOlder } = useConversationMessages(id);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      await pollConversation(id);
      if (!cancelled) setSynced(true);
    })();

    // Audit fix: this previously polled every POLL_MS unconditionally,
    // including while backgrounded — the single clearest battery/network
    // cost found in the client audit, compounding with ChatContext's own
    // conversation-list poll. Paused while AppState isn't 'active', with
    // an immediate refresh on returning to foreground so messages aren't
    // stale on resume.
    let ticks = 0;
    const poll = () => {
      ticks += 1;
      if (realtime.getStatus() === 'online' && ticks % ONLINE_POLL_EVERY !== 0) return;
      pollConversation(id);
    };
    let interval: ReturnType<typeof setInterval> | null = null;
    const startInterval = () => {
      if (interval) return;
      interval = setInterval(poll, POLL_MS);
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

  // Stable callbacks, so neither the memoized composer nor the memoized
  // bubbles re-render when a message arrives.
  const handleSend = useCallback(
    async (text: string) => {
      if (!id) return;
      try {
        await sendChatMessage(id, text);
      } catch (err) {
        Alert.alert('Could not send message', getApiErrorMessage(err));
      }
    },
    [id, sendChatMessage],
  );

  const handleSendVoice = useCallback(
    async (uri: string, durationMs: number) => {
      if (!id) return;
      try {
        await sendVoiceMessage(id, uri, durationMs);
      } catch (err) {
        Alert.alert('Could not send voice message', getApiErrorMessage(err));
      }
    },
    [id, sendVoiceMessage],
  );

  const handleRetry = useCallback(
    (messageId: string) => {
      if (id) retryMessage(id, messageId);
    },
    [id, retryMessage],
  );

  const handleDownloadAudio = useCallback(
    (messageId: string) => {
      if (id) downloadVoiceMessage(id, messageId);
    },
    [id, downloadVoiceMessage],
  );

  const handleEndReached = useCallback(() => {
    if (id) loadOlderMessages(id);
  }, [id]);

  const handleCall = useCallback(
    (media: 'audio' | 'video') => {
      if (!id) return;
      startCall(id, media).catch((err) => Alert.alert('Couldn’t start the call', getApiErrorMessage(err)));
    },
    [id, startCall],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Message>) => (
      <MessageBubble
        message={item}
        isOwn={item.senderDeviceId === deviceId}
        onRetry={handleRetry}
        onDownloadAudio={handleDownloadAudio}
      />
    ),
    [deviceId, handleRetry, handleDownloadAudio],
  );

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
          leading={
            conversation ? <UserAvatar userId={conversation.otherUserId} name={conversation.otherDisplayName} size="sm" /> : undefined
          }
          onTitlePress={conversation ? () => openUserProfile(conversation.otherUserId) : undefined}
          titleAccessibilityLabel={conversation ? `View ${conversation.otherDisplayName}'s profile` : undefined}
          rightSlot={
            conversation?.groupJoined ? (
              <View style={styles.callButtons}>
                <IconButton name="call-outline" accessibilityLabel="Start voice call" onPress={() => handleCall('audio')} />
                <IconButton name="videocam-outline" accessibilityLabel="Start video call" onPress={() => handleCall('video')} />
              </View>
            ) : undefined
          }
        />
        {!synced && messages.length === 0 ? (
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
          // `inverted` keeps new messages pinned to the bottom without manual
          // scroll management; `messages` is already newest first.
          <FlatList
            data={messages}
            inverted
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            initialNumToRender={15}
            windowSize={11}
            onEndReached={hasOlder ? handleEndReached : undefined}
            onEndReachedThreshold={0.5}
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
  callButtons: {
    flexDirection: 'row',
    gap: 4,
  },
});
