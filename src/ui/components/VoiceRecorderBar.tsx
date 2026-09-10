import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

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
  onCancel: () => void;
  onStop: () => void;
}

/** Replaces the composer's text row while actively recording — indicator, elapsed time, cancel, stop. */
export function VoiceRecorderBar({ elapsedMs, onCancel, onStop }: VoiceRecorderBarProps): React.JSX.Element {
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

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background, borderTopColor: theme.colors.border }]}>
      <IconButton name="trash-outline" accessibilityLabel="Cancel recording" onPress={onCancel} />
      <View style={styles.center}>
        <Animated.View style={[styles.dot, { backgroundColor: theme.colors.danger, opacity: pulse }]} />
        <AppText variant="body" color="secondary">
          Recording… {formatClockDuration(elapsedMs)}
        </AppText>
      </View>
      <IconButton name="stop-circle" accessibilityLabel="Stop recording" onPress={onStop} variant="filled" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  center: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
});
