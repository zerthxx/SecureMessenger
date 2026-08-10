import { useRef } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import type { BottomTabBarProps } from 'expo-router/js-tabs';

import { useTheme } from '@/ui/theme';
import { AppText } from './AppText';
import { Badge } from './Badge';

interface NavItemProps {
  label: string;
  isFocused: boolean;
  icon: React.ReactNode;
  badge?: number;
  onPress: () => void;
  onLongPress: () => void;
}

function NavItem({ label, isFocused, icon, badge, onPress, onLongPress }: NavItemProps): React.JSX.Element {
  const theme = useTheme();
  const scale = useRef(new Animated.Value(1)).current;

  const animateTo = (toValue: number) => {
    Animated.spring(scale, { toValue, useNativeDriver: true, speed: 40, bounciness: 6 }).start();
  };

  const tint = isFocused ? theme.colors.primary : theme.colors.textSecondary;

  return (
    <Pressable
      onPress={() => {
        animateTo(1);
        onPress();
      }}
      onLongPress={onLongPress}
      onPressIn={() => animateTo(0.88)}
      onPressOut={() => animateTo(1)}
      accessibilityRole="tab"
      accessibilityState={{ selected: isFocused }}
      accessibilityLabel={label}
      style={styles.item}
    >
      <Animated.View style={[styles.iconWrap, { transform: [{ scale }] }]}>
        {icon}
        {badge ? (
          <View style={styles.badgeSlot}>
            <Badge count={badge} />
          </View>
        ) : null}
      </Animated.View>
      <AppText variant="caption" style={{ color: tint, fontWeight: isFocused ? '700' : '400' }}>
        {label}
      </AppText>
    </Pressable>
  );
}

/** Custom bottom tab bar. Tab icon/label/badge come from each Tabs.Screen's `options`. */
export function BottomNav({ state, descriptors, navigation, insets }: BottomTabBarProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
          paddingBottom: Math.max(insets.bottom, theme.spacing.sm),
        },
      ]}
    >
      {state.routes.map((route, index) => {
        const { options } = descriptors[route.key] ?? {};
        const isFocused = state.index === index;
        const label = (options?.title ?? route.name) as string;
        const tint = isFocused ? theme.colors.primary : theme.colors.textSecondary;
        const badgeValue = options?.tabBarBadge;

        const onPress = () => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!isFocused && !event.defaultPrevented) {
            navigation.navigate(route.name);
          }
        };

        const onLongPress = () => {
          navigation.emit({ type: 'tabLongPress', target: route.key });
        };

        return (
          <NavItem
            key={route.key}
            label={label}
            isFocused={isFocused}
            badge={typeof badgeValue === 'number' ? badgeValue : undefined}
            icon={options?.tabBarIcon?.({ focused: isFocused, color: tint, size: 24 }) ?? null}
            onPress={onPress}
            onLongPress={onLongPress}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    minHeight: 48,
  },
  iconWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeSlot: {
    position: 'absolute',
    top: -6,
    right: -10,
  },
});
