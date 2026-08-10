import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { Message } from '@/domain/entities';
import { useTheme } from '@/ui/theme';
import { AppText } from './AppText';

export interface MessageBubbleProps {
  message: Message;
  isOwn: boolean;
  onRetry?: () => void;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function MessageBubble({ message, isOwn, onRetry }: MessageBubbleProps): React.JSX.Element {
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

  const isFailedSend = message.status === 'failed';
  const bubbleColor = isOwn ? theme.colors.primary : theme.colors.surfaceElevated;
  const textColor = isOwn ? theme.colors.onPrimary : theme.colors.textPrimary;

  const bubble = (
    <View
      style={[
        styles.bubble,
        {
          backgroundColor: isFailedSend ? theme.colors.surfaceElevated : bubbleColor,
          borderColor: isFailedSend ? theme.colors.danger : 'transparent',
          borderWidth: isFailedSend ? 1.5 : 0,
        },
      ]}
    >
      <AppText variant="body" style={{ color: isFailedSend ? theme.colors.textPrimary : textColor }}>
        {message.text}
      </AppText>
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
        <Pressable onPress={onRetry} accessibilityRole="button" accessibilityLabel="Retry sending message">
          {bubble}
        </Pressable>
      ) : (
        bubble
      )}
    </View>
  );
}

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
