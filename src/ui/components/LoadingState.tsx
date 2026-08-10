import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

import { useTheme } from '@/ui/theme';

function Shimmer({ width, height, radius }: { width: number | `${number}%`; height: number; radius: number }): React.JSX.Element {
  const theme = useTheme();
  const opacity = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 650, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.5, duration: 650, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={{ width, height, borderRadius: radius, backgroundColor: theme.colors.skeleton, opacity }}
    />
  );
}

/** Skeleton rows shaped like a chat/list item — used while mock data "loads". */
export function LoadingState({ rows = 6 }: { rows?: number }): React.JSX.Element {
  const theme = useTheme();

  return (
    <View style={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}>
      {Array.from({ length: rows }).map((_, index) => (
        <View key={index} style={styles.row}>
          <Shimmer width={48} height={48} radius={24} />
          <View style={styles.lines}>
            <Shimmer width="60%" height={14} radius={7} />
            <Shimmer width="90%" height={12} radius={6} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  lines: {
    flex: 1,
    gap: 8,
  },
});
