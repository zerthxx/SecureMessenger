import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/ui/theme';
import { AppText } from './AppText';

export interface BadgeProps {
  count: number;
  max?: number;
  tone?: 'accent' | 'primary' | 'neutral';
}

export function Badge({ count, max = 99, tone = 'accent' }: BadgeProps): React.JSX.Element | null {
  const theme = useTheme();
  if (count <= 0) return null;

  const backgroundColor =
    tone === 'accent' ? theme.colors.accent : tone === 'primary' ? theme.colors.primary : theme.colors.surfaceElevated;
  const textColor = tone === 'neutral' ? theme.colors.textPrimary : theme.colors.onAccent;

  return (
    <View style={[styles.container, { backgroundColor, borderRadius: theme.radius.full }]}>
      <AppText variant="caption" style={[styles.text, { color: textColor }]}>
        {count > max ? `${max}+` : String(count)}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '700',
  },
});
