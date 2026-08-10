import { Text, type TextProps } from 'react-native';

import { useTheme } from '@/ui/theme';
import type { TypographyVariant } from '@/ui/theme';

export interface AppTextProps extends TextProps {
  variant?: TypographyVariant;
  color?: 'primary' | 'secondary' | 'tertiary' | 'accent' | 'danger' | 'inherit';
}

export function AppText({ variant = 'body', color = 'primary', style, ...rest }: AppTextProps): React.JSX.Element {
  const theme = useTheme();

  const colorValue =
    color === 'inherit'
      ? undefined
      : color === 'primary'
        ? theme.colors.textPrimary
        : color === 'secondary'
          ? theme.colors.textSecondary
          : color === 'tertiary'
            ? theme.colors.textTertiary
            : color === 'accent'
              ? theme.colors.accent
              : theme.colors.danger;

  return <Text style={[theme.typography[variant], colorValue ? { color: colorValue } : null, style]} {...rest} />;
}
