import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/ui/theme';

export function StepDots({ total, current }: { total: number; current: number }): React.JSX.Element {
  const theme = useTheme();

  return (
    <View style={styles.row}>
      {Array.from({ length: total }).map((_, index) => (
        <View
          key={index}
          style={[
            styles.dot,
            {
              width: index === current ? 20 : 6,
              backgroundColor: index <= current ? theme.colors.primary : theme.colors.border,
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
  },
  dot: {
    height: 6,
    borderRadius: 3,
  },
});
