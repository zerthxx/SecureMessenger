import { useRef } from 'react';
import { Animated, Pressable, StyleSheet, View, type GestureResponderEvent } from 'react-native';

import { useTheme } from '@/ui/theme';
import { AppText } from './AppText';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'lg';

export interface ButtonProps {
  label: string;
  onPress?: (event: GestureResponderEvent) => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  icon?: React.ReactNode;
  testID?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  fullWidth = false,
  icon,
  testID,
}: ButtonProps): React.JSX.Element {
  const theme = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  const isDisabled = disabled || loading;

  const animateTo = (toValue: number) => {
    Animated.spring(scale, { toValue, useNativeDriver: true, speed: 40, bounciness: 6 }).start();
  };

  const backgroundColor =
    variant === 'primary'
      ? theme.colors.primary
      : variant === 'danger'
        ? theme.colors.danger
        : variant === 'secondary'
          ? theme.colors.surfaceElevated
          : 'transparent';

  const textColor =
    variant === 'primary' || variant === 'danger'
      ? theme.colors.onPrimary
      : theme.colors.textPrimary;

  const borderColor = variant === 'ghost' ? theme.colors.border : 'transparent';

  return (
    <Animated.View style={[fullWidth ? styles.fullWidth : null, { transform: [{ scale }] }]}>
      <Pressable
        testID={testID}
        onPress={onPress}
        disabled={isDisabled}
        onPressIn={() => !isDisabled && animateTo(0.96)}
        onPressOut={() => !isDisabled && animateTo(1)}
        accessibilityRole="button"
        accessibilityState={{ disabled: isDisabled, busy: loading }}
        hitSlop={8}
        style={[
          styles.base,
          size === 'lg' ? styles.lg : styles.md,
          {
            backgroundColor,
            borderColor,
            borderWidth: variant === 'ghost' ? StyleSheet.hairlineWidth * 2 : 0,
            borderRadius: theme.radius.md,
            opacity: isDisabled ? 0.5 : 1,
          },
        ]}
      >
        {loading ? (
          <Animated.View style={styles.spinnerPlaceholder}>
            <AppText variant="bodyMedium" style={{ color: textColor }}>
              …
            </AppText>
          </Animated.View>
        ) : (
          <View style={styles.content}>
            {icon}
            <AppText variant="bodyMedium" style={{ color: textColor }}>
              {label}
            </AppText>
          </View>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  md: {
    minHeight: 48,
    paddingHorizontal: 16,
  },
  lg: {
    minHeight: 56,
    paddingHorizontal: 20,
  },
  fullWidth: {
    width: '100%',
  },
  spinnerPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
