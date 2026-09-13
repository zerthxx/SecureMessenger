import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/ui/theme';
import { AppText } from './AppText';
import { IconButton } from './IconButton';

export function formatClockDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export interface VoiceRecorderBarProps {
  elapsedMs: number;
  /** Leftward drag distance (px) while holding the record button. */
  slideDistance?: number;
  /** Drag distance at which the recording is cancelled. */
  cancelDistance?: number;
  /** Explicit controls, shown instead of the slide hint when recording was started by a screen reader. */
  onCancel?: () => void;
  onSend?: () => void;
}

/** Replaces the composer's text field while recording — pulsing indicator, elapsed time, and slide-to-cancel hint (or explicit buttons for screen-reader users). */
export function VoiceRecorderBar({ elapsedMs, slideDistance = 0, cancelDistance = 110, onCancel, onSend }: VoiceRecorderBarProps): React.JSX.Element {
  const theme = useTheme();
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.3, duration: 600, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const progress = Math.min(1, slideDistance / cancelDistance);
  const nearCancel = progress > 0.75;

  return (
    <View
      style={[styles.container, { backgroundColor: theme.colors.surfaceElevated, borderRadius: theme.radius.md }]}
      accessibilityLiveRegion="polite"
      accessibilityLabel={`Recording voice message, ${formatClockDuration(elapsedMs)}`}
    >
      <Animated.View style={[styles.dot, { backgroundColor: theme.colors.danger, opacity: pulse }]} />
      <AppText variant="bodyMedium" style={styles.timer}>
        {formatClockDuration(elapsedMs)}
      </AppText>
      {onCancel && onSend ? (
        <View style={styles.buttons}>
          <IconButton name="trash-outline" accessibilityLabel="Cancel recording" onPress={onCancel} />
          <IconButton name="send" accessibilityLabel="Send voice message" onPress={onSend} variant="filled" />
        </View>
      ) : (
        <View style={[styles.hint, { opacity: 1 - progress * 0.6, transform: [{ translateX: -slideDistance * 0.4 }] }]}>
          <Ionicons name="chevron-back" size={16} color={nearCancel ? theme.colors.danger : theme.colors.textSecondary} />
          <AppText variant="body" color={nearCancel ? 'danger' : 'secondary'}>
            Slide to cancel
          </AppText>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 14,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  timer: {
    minWidth: 40,
  },
  hint: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
  },
  buttons: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
});
