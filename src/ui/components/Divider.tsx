import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/ui/theme';

export function Divider({ inset = 0 }: { inset?: number }): React.JSX.Element {
  const theme = useTheme();
  return <View style={[styles.line, { backgroundColor: theme.colors.border, marginLeft: inset }]} />;
}

const styles = StyleSheet.create({
  line: {
    height: StyleSheet.hairlineWidth,
  },
});
