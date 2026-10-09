import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, FlatList, KeyboardAvoidingView, Platform, StyleSheet, View, type ListRenderItemInfo } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import type { Message } from '@/domain/entities';
import { nextPollDelayMs } from '@/infrastructure/network/pollSchedule';
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

/** The first wait between polls while the realtime socket is down; each quiet poll doubles it (see pollSchedule.ts). */
const POLL_MS = 3000;
/** The wait with the socket connected (new messages arrive as hints instead), and the cap while it is down. */
const ONLINE_POLL_MS = 30_000;

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
  // Read by the poll timer below to tell a quiet poll from one that found
  // something (a reply, or this person's own send) without re-running the effect.
  const messageCountRef = useRef(messages.length);
  messageCountRef.current = messages.length;

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      await pollConversation(id);
      if (!cancelled) setSynced(true);
    })();

    // Polls only while the app is in the foreground (an audit fix: polling
    // while backgrounded was the clearest battery/network cost), with an
    // immediate refresh on returning so messages aren't stale on resume.
    //
    // The wait between polls comes from pollSchedule.ts: a slow, jittered
    // safety net while the realtime socket delivers hints; while the socket
    // is down, polling IS the delivery path, so it starts fast and backs
    // off with every quiet poll (3 → 6 → 12 → 24 → 30 s), resetting whenever
    // a poll found messages, the person sent one, or the app came to the
    // foreground. A fixed 3 s cadence turned a realtime outage into a
    // database outage at scale (docs/ENGINEERING_CHECKLIST.md, S1).
    let quietPolls = 0;
    let lastCount = messageCountRef.current;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer || cancelled) return;
      const delay = nextPollDelayMs({ realtimeOnline: realtime.getStatus() === 'online', quietPolls, baseMs: POLL_MS, onlineMs: ONLINE_POLL_MS });
      timer = setTimeout(async () => {
        timer = null;
        const online = realtime.getStatus() === 'online';
        await pollConversation(id);
        if (cancelled) return;
        const count = messageCountRef.current;
        quietPolls = online || count !== lastCount ? 0 : quietPolls + 1;
        lastCount = count;
        if (AppState.currentState === 'active') schedule();
      }, delay);
    };
    const stop = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    if (AppState.currentState === 'active') schedule();

    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        quietPolls = 0;
        pollConversation(id);
        schedule();
      } else {
        stop();
      }
    });

    return () => {
      cancelled = true;
      stop();
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
        isOwn={item.direction === 'outgoing'}
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
      // Android too: the app draws edge to edge, where the window no longer
      // shrinks for the keyboard (adjustResize), so without padding the
      // keyboard covered the composer.
      behavior="padding"
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
