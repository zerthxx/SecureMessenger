import { StyleSheet, View, type ViewProps } from 'react-native';

import { useTheme } from '@/ui/theme';

export interface CardProps extends ViewProps {
  elevationLevel?: 0 | 1 | 2 | 3 | 4;
  padded?: boolean;
}

export function Card({ elevationLevel = 1, padded = true, style, children, ...rest }: CardProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.base,
        theme.elevation[elevationLevel],
        {
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radius.lg,
          padding: padded ? theme.spacing.lg : 0,
        },
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    overflow: 'visible',
  },
});
