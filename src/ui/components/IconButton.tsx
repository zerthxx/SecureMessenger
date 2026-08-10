import { useRef } from 'react';
import { Animated, Pressable, type GestureResponderEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/ui/theme';

export interface IconButtonProps {
  name: keyof typeof Ionicons.glyphMap;
  onPress?: (event: GestureResponderEvent) => void;
  size?: number;
  variant?: 'plain' | 'filled';
  accessibilityLabel: string;
  testID?: string;
}

export function IconButton({
  name,
  onPress,
  size = 22,
  variant = 'plain',
  accessibilityLabel,
  testID,
}: IconButtonProps): React.JSX.Element {
  const theme = useTheme();
  const scale = useRef(new Animated.Value(1)).current;

  const animateTo = (toValue: number) => {
    Animated.spring(scale, { toValue, useNativeDriver: true, speed: 40, bounciness: 6 }).start();
  };

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable
        testID={testID}
        onPress={onPress}
        onPressIn={() => animateTo(0.9)}
        onPressOut={() => animateTo(1)}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        hitSlop={10}
        style={{
          width: 44,
          height: 44,
          borderRadius: theme.radius.full,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: variant === 'filled' ? theme.colors.surfaceElevated : 'transparent',
        }}
      >
        <Ionicons name={name} size={size} color={theme.colors.textPrimary} />
      </Pressable>
    </Animated.View>
  );
}
