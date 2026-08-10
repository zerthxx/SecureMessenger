import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

import { useTheme } from '@/ui/theme';
import { AppText, BrandMark } from '@/ui/components';

/** Purely presentational — the route file owns the auto-advance timer. */
export function SplashScreen(): React.JSX.Element {
  const theme = useTheme();
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(12)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 420, useNativeDriver: true }),
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true, speed: 10, bounciness: 6 }),
    ]).start();
  }, [opacity, translateY]);

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Animated.View style={{ opacity, transform: [{ translateY }], alignItems: 'center' }}>
        <BrandMark size={84} />
        <AppText variant="headline" style={styles.wordmark}>
          Secure Messenger
        </AppText>
        <AppText variant="body" color="secondary">
          Private, by design.
        </AppText>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wordmark: {
    marginTop: 20,
    marginBottom: 4,
  },
});
