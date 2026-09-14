import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { Message } from '@/domain/entities';
import { pauseVoiceMessage, playVoiceMessage } from '@/infrastructure/media/voicePlayer';
import { useVoicePlaybackState } from '@/ui/hooks/useVoicePlayback';
import { useTheme } from '@/ui/theme';
import { AppText } from './AppText';
import { formatClockDuration } from './VoiceRecorderBar';

export interface MessageBubbleProps {
  message: Message;
  isOwn: boolean;
  /** Called with the message id when a message that failed to send is tapped. */
  onRetry?: (messageId: string) => void;
  /** Called with the message id when a received voice message's audio hasn't been downloaded yet (or a previous download failed) and the user taps play. */
  onDownloadAudio?: (messageId: string) => void;
}

// Intl time formatting is comparatively slow on Hermes, and bubbles are
// re-created as the list scrolls — each timestamp is formatted once.
const timeLabels = new Map<string, string>();

function formatTime(iso: string): string {
  let label = timeLabels.get(iso);
  if (label === undefined) {
    const date = new Date(iso);
    label = Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (timeLabels.size >= 5000) timeLabels.clear();
    timeLabels.set(iso, label);
  }
  return label;
}

function VoiceBubbleContent({
  message,
  isOwn,
  onDownloadAudio,
}: {
  message: Message;
  isOwn: boolean;
  onDownloadAudio?: (messageId: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const playback = useVoicePlaybackState(message.id);
  const isActivePlayer = playback.duration > 0 || playback.playing;
  const totalMs = message.audioDurationMs ?? 0;
  const currentMs = isActivePlayer ? playback.currentTime * 1000 : 0;
  const progress = isActivePlayer && playback.duration > 0 ? Math.min(1, currentMs / (playback.duration * 1000)) : 0;

  const iconColor = isOwn ? theme.colors.onPrimary : theme.colors.textPrimary;
  const trackColor = isOwn ? 'rgba(255,255,255,0.35)' : theme.colors.border;
  const fillColor = isOwn ? theme.colors.onPrimary : theme.colors.primary;

  function handlePress() {
    if (message.audioState === 'downloaded' && message.audioLocalUri) {
      if (playback.playing) {
        pauseVoiceMessage(message.id);
      } else {
        playVoiceMessage(message.id, message.audioLocalUri);
      }
      return;
    }
    // idle, failed, or (defensively) any other non-ready state — (re)try fetching+decrypting the blob.
    if (message.audioState !== 'downloading') {
      onDownloadAudio?.(message.id);
    }
  }

  const isDownloading = message.audioState === 'downloading';
  const isFailedAudio = message.audioState === 'failed';

  let icon: keyof typeof Ionicons.glyphMap;
  let accessibilityLabel: string;
  if (isDownloading) {
    icon = 'ellipsis-horizontal';
    accessibilityLabel = 'Downloading voice message';
  } else if (isFailedAudio) {
    icon = 'refresh';
    accessibilityLabel = 'Retry voice message';
  } else if (playback.playing) {
    icon = 'pause';
    accessibilityLabel = 'Pause voice message';
  } else {
    icon = 'play';
    accessibilityLabel = 'Play voice message';
  }

  return (
    <View style={styles.voiceRow}>
      <Pressable
        onPress={handlePress}
        disabled={isDownloading}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        hitSlop={8}
        style={[styles.voicePlayButton, { backgroundColor: isOwn ? 'rgba(255,255,255,0.2)' : theme.colors.primaryMuted }]}
      >
        <Ionicons name={icon} size={18} color={isFailedAudio ? theme.colors.danger : iconColor} />
      </Pressable>
      <View style={styles.voiceMeta}>
        <View style={[styles.voiceTrack, { backgroundColor: trackColor }]}>
          <View style={[styles.voiceTrackFill, { backgroundColor: fillColor, width: `${progress * 100}%` }]} />
        </View>
        <AppText variant="caption" style={{ color: isOwn ? theme.colors.onPrimary : theme.colors.textTertiary }}>
          {isFailedAudio
            ? 'Couldn’t load audio · Tap to retry'
            : `${formatClockDuration(isActivePlayer ? currentMs : 0)} / ${formatClockDuration(totalMs)}`}
        </AppText>
      </View>
    </View>
  );
}

/**
 * Memoized: the conversation list keeps unchanged `Message` objects and
 * passes stable callbacks, so a new or updated message re-renders only its
 * own bubble instead of every bubble on screen.
 */
export const MessageBubble = memo(function MessageBubble({ message, isOwn, onRetry, onDownloadAudio }: MessageBubbleProps): React.JSX.Element {
  const theme = useTheme();

  // SECURITY: a failed decryption must never fall back to showing
  // ciphertext, a guessed value, or anything server-supplied as if it
  // were the message content — this branch is the only place a
  // decryption_failed message renders, and it never reads
  // message.text (which the domain layer already guarantees is null
  // for this status, but the UI does not rely on that alone).
  if (message.status === 'decryption_failed') {
    return (
      <View style={[styles.row, isOwn ? styles.rowOwn : styles.rowOther]}>
        <View style={[styles.bubble, styles.failedBubble, { borderColor: theme.colors.danger }]}>
          <Ionicons name="lock-closed-outline" size={14} color={theme.colors.danger} style={styles.failedIcon} />
          <AppText variant="body" color="danger" style={styles.failedText}>
            Unable to decrypt this message
          </AppText>
        </View>
      </View>
    );
  }

  const isVoice = message.kind === 'voice';
  const isFailedSend = message.status === 'failed';
  const bubbleColor = isOwn ? theme.colors.primary : theme.colors.surfaceElevated;
  const textColor = isOwn ? theme.colors.onPrimary : theme.colors.textPrimary;

  const bubble = (
    <View
      style={[
        styles.bubble,
        isVoice && styles.voiceBubble,
        {
          backgroundColor: isFailedSend ? theme.colors.surfaceElevated : bubbleColor,
          borderColor: isFailedSend ? theme.colors.danger : 'transparent',
          borderWidth: isFailedSend ? 1.5 : 0,
        },
      ]}
    >
      {isVoice ? (
        <VoiceBubbleContent message={message} isOwn={isOwn} onDownloadAudio={onDownloadAudio} />
      ) : (
        <AppText variant="body" style={{ color: isFailedSend ? theme.colors.textPrimary : textColor }}>
          {message.text}
        </AppText>
      )}
      <View style={styles.metaRow}>
        {message.status === 'sending' ? (
          <Ionicons name="time-outline" size={12} color={isOwn ? theme.colors.onPrimary : theme.colors.textTertiary} />
        ) : null}
        {message.status === 'sent' ? (
          <Ionicons name="checkmark" size={13} color={isOwn ? theme.colors.onPrimary : theme.colors.textTertiary} />
        ) : null}
        {isFailedSend ? <Ionicons name="alert-circle" size={13} color={theme.colors.danger} /> : null}
        <AppText
          variant="caption"
          style={{
            color: isFailedSend ? theme.colors.danger : isOwn ? theme.colors.onPrimary : theme.colors.textTertiary,
          }}
        >
          {isFailedSend ? 'Failed to send · Tap to retry' : formatTime(message.createdAt)}
        </AppText>
      </View>
    </View>
  );

  return (
    <View style={[styles.row, isOwn ? styles.rowOwn : styles.rowOther]}>
      {isFailedSend && onRetry ? (
        <Pressable
          onPress={() => onRetry(message.id)}
          accessibilityRole="button"
          accessibilityLabel={isVoice ? 'Retry voice message' : 'Retry sending message'}
        >
          {bubble}
        </Pressable>
      ) : (
        bubble
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 3,
  },
  rowOwn: {
    justifyContent: 'flex-end',
  },
  rowOther: {
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '78%',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  voiceBubble: {
    minWidth: 180,
  },
  voiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  voicePlayButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceMeta: {
    flex: 1,
    gap: 4,
  },
  voiceTrack: {
    height: 3,
    borderRadius: 2,
    overflow: 'hidden',
  },
  voiceTrackFill: {
    height: '100%',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 3,
    alignSelf: 'flex-end',
  },
  failedBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderStyle: 'dashed',
    backgroundColor: 'transparent',
  },
  failedIcon: {
    marginRight: 6,
  },
  failedText: {
    fontStyle: 'italic',
  },
});
