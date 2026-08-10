import { useRef } from 'react';
import { Animated, Pressable, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/ui/theme';
import { AppText } from './AppText';

export interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  label?: string;
  helperText?: string;
  errorText?: string;
  leadingIcon?: keyof typeof Ionicons.glyphMap;
  trailingIcon?: keyof typeof Ionicons.glyphMap;
  onTrailingIconPress?: () => void;
}

export function TextField({
  label,
  helperText,
  errorText,
  leadingIcon,
  trailingIcon,
  onTrailingIconPress,
  onFocus,
  onBlur,
  ...rest
}: TextFieldProps): React.JSX.Element {
  const theme = useTheme();
  const borderAnim = useRef(new Animated.Value(0)).current;

  const hasError = Boolean(errorText);

  const animateFocus = (toValue: number) => {
    Animated.timing(borderAnim, { toValue, duration: 150, useNativeDriver: false }).start();
  };

  const borderColor = borderAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [hasError ? theme.colors.danger : theme.colors.border, hasError ? theme.colors.danger : theme.colors.primary],
  });

  return (
    <View>
      {label ? (
        <AppText variant="label" color="secondary" style={styles.label}>
          {label}
        </AppText>
      ) : null}
      <Animated.View
        style={[
          styles.container,
          {
            borderColor: hasError ? theme.colors.danger : borderColor,
            backgroundColor: theme.colors.surfaceElevated,
            borderRadius: theme.radius.md,
          },
        ]}
      >
        {leadingIcon ? (
          <Ionicons name={leadingIcon} size={18} color={theme.colors.textSecondary} style={styles.leadingIcon} />
        ) : null}
        <TextInput
          style={[theme.typography.bodyLarge, styles.input, { color: theme.colors.textPrimary }]}
          placeholderTextColor={theme.colors.textTertiary}
          onFocus={(e) => {
            animateFocus(1);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            animateFocus(0);
            onBlur?.(e);
          }}
          accessibilityLabel={label}
          {...rest}
        />
        {trailingIcon ? (
          <Pressable
            onPress={onTrailingIconPress}
            accessibilityRole="button"
            hitSlop={8}
            style={styles.trailingIcon}
          >
            <Ionicons name={trailingIcon} size={18} color={theme.colors.textSecondary} />
          </Pressable>
        ) : null}
      </Animated.View>
      {errorText || helperText ? (
        <AppText variant="caption" color={hasError ? 'danger' : 'secondary'} style={styles.helper}>
          {errorText ?? helperText}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    marginBottom: 6,
  },
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    minHeight: 48,
    paddingHorizontal: 14,
  },
  leadingIcon: {
    marginRight: 8,
  },
  trailingIcon: {
    marginLeft: 8,
    padding: 4,
  },
  input: {
    flex: 1,
    paddingVertical: 12,
  },
  helper: {
    marginTop: 6,
    marginLeft: 2,
  },
});
