import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/ui/theme';
import { AppText } from './AppText';
import { IconButton } from './IconButton';

export interface TopBarProps {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  rightSlot?: React.ReactNode;
  large?: boolean;
  /** Shown before the title, e.g. the other person's avatar in a chat. */
  leading?: React.ReactNode;
  /** Makes the title area (leading element + title) tappable. */
  onTitlePress?: () => void;
  titleAccessibilityLabel?: string;
}

export function TopBar({
  title,
  subtitle,
  onBack,
  rightSlot,
  large = false,
  leading,
  onTitlePress,
  titleAccessibilityLabel,
}: TopBarProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const titleContent = (
    <>
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.titleText}>
        <AppText variant={large ? 'headline' : 'title'} numberOfLines={1}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText variant="caption" color="secondary" numberOfLines={1}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
    </>
  );

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top + theme.spacing.sm,
          paddingHorizontal: theme.spacing.lg,
          backgroundColor: theme.colors.background,
        },
      ]}
    >
      <View style={styles.row}>
        {onBack ? (
          <IconButton name="chevron-back" accessibilityLabel="Go back" onPress={onBack} />
        ) : (
          <View style={styles.spacer} />
        )}
        {onTitlePress ? (
          <Pressable
            onPress={onTitlePress}
            accessibilityRole="button"
            accessibilityLabel={titleAccessibilityLabel ?? title}
            style={({ pressed }) => [styles.titleWrap, pressed ? { opacity: 0.6 } : null]}
          >
            {titleContent}
          </Pressable>
        ) : (
          <View style={styles.titleWrap}>{titleContent}</View>
        )}
        <View style={styles.actions}>{rightSlot}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
  },
  spacer: {
    width: 44,
  },
  titleWrap: {
    flex: 1,
    marginLeft: 4,
    flexDirection: 'row',
    alignItems: 'center',
  },
  leading: {
    marginRight: 10,
  },
  titleText: {
    flex: 1,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
});
