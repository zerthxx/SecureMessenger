import { StyleSheet, View } from 'react-native';

import { evaluatePasswordStrength } from '@/core/utils/passwordStrength';
import { useTheme } from '@/ui/theme';
import { AppText } from './AppText';

export function PasswordStrengthMeter({ password }: { password: string }): React.JSX.Element | null {
  const theme = useTheme();
  if (!password) return null;

  const strength = evaluatePasswordStrength(password);
  const toneColor = theme.colors[strength.tone];
  const segments = 4;

  return (
    <View style={styles.container}>
      <View style={styles.bars}>
        {Array.from({ length: segments }).map((_, index) => (
          <View
            key={index}
            style={[
              styles.bar,
              { backgroundColor: index < strength.score ? toneColor : theme.colors.border },
            ]}
          />
        ))}
      </View>
      <AppText variant="caption" style={{ color: toneColor }}>
        {strength.label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: -8,
    gap: 6,
  },
  bars: {
    flexDirection: 'row',
    gap: 4,
  },
  bar: {
    flex: 1,
    height: 4,
    borderRadius: 2,
  },
});
