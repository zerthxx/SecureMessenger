import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/ui/theme';
import { palette } from '@/ui/theme/palette';
import { AppText } from './AppText';

export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';

const SIZES: Record<AvatarSize, number> = { sm: 32, md: 44, lg: 56, xl: 88 };

const AVATAR_HUES = [
  palette.violet500,
  palette.coral500,
  palette.green500,
  palette.violet700,
  palette.coral600,
  palette.violet400,
];

function hueForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return AVATAR_HUES[hash % AVATAR_HUES.length] ?? palette.violet500;
}

function initialsForName(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((part) => /^\p{L}/u.test(part));
  const first = parts[0]?.[0] ?? '';
  const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + second).toUpperCase();
}

export interface AvatarProps {
  name: string;
  size?: AvatarSize;
  online?: boolean;
  ringColor?: string;
}

export function Avatar({ name, size = 'md', online, ringColor }: AvatarProps): React.JSX.Element {
  const theme = useTheme();
  const dimension = SIZES[size];
  const ringWidth = ringColor ? 2.5 : 0;
  const outerDimension = dimension + ringWidth * 2 + (ringColor ? 4 : 0);

  const circle = (
    <View
      style={[
        styles.circle,
        {
          width: dimension,
          height: dimension,
          borderRadius: dimension / 2,
          backgroundColor: hueForName(name),
        },
      ]}
    >
      <AppText
        variant={size === 'xl' ? 'title' : size === 'sm' ? 'caption' : 'label'}
        style={{ color: palette.neutral0, textAlign: 'center', includeFontPadding: false }}
        numberOfLines={1}
        accessibilityElementsHidden
      >
        {initialsForName(name)}
      </AppText>
    </View>
  );

  return (
    <View style={{ width: outerDimension, height: outerDimension }} accessibilityLabel={`${name} avatar`}>
      {ringColor ? (
        <View
          style={[
            styles.ring,
            {
              width: outerDimension,
              height: outerDimension,
              borderRadius: outerDimension / 2,
              borderColor: ringColor,
              borderWidth: ringWidth,
              padding: 2,
            },
          ]}
        >
          {circle}
        </View>
      ) : (
        circle
      )}
      {online ? (
        <View
          style={[
            styles.onlineDot,
            {
              backgroundColor: theme.colors.online,
              borderColor: theme.colors.surface,
              width: dimension * 0.28,
              height: dimension * 0.28,
              borderRadius: dimension * 0.14,
            },
          ]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  onlineDot: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    borderWidth: 2,
  },
});
