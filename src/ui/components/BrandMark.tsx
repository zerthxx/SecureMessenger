import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/ui/theme';

/**
 * Abstract original mark: two overlapping rounded forms (violet + coral) —
 * deliberately not a paper plane, padlock, or ghost.
 */
export function BrandMark({ size = 72 }: { size?: number }): React.JSX.Element {
  const theme = useTheme();
  const accentSize = size * 0.62;

  return (
    <View style={{ width: size, height: size }}>
      <View
        style={[
          styles.shape,
          {
            width: size,
            height: size,
            borderRadius: size * 0.32,
            backgroundColor: theme.colors.primary,
          },
        ]}
      />
      <View
        style={[
          styles.shape,
          styles.accentShape,
          {
            width: accentSize,
            height: accentSize,
            borderRadius: accentSize * 0.32,
            backgroundColor: theme.colors.accent,
            right: -accentSize * 0.18,
            bottom: -accentSize * 0.18,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  shape: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  accentShape: {
    top: undefined,
    left: undefined,
  },
});
