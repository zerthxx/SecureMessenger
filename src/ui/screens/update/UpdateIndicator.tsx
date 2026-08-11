import { Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/ui/theme';
import { useAppUpdate } from './UpdateContext';

/**
 * The small persistent "an update is still available" affordance. Mounted
 * once at the app root (see app/_layout.tsx), stacked above the
 * navigator so it survives Home → Chats → Conversation → Settings →
 * Profile navigation untouched. Visibility is driven solely by
 * `updatePending` (installed vs. manifest versionCode) — never by
 * whether the big dialog has been dismissed, so pressing "Later" on that
 * dialog cannot make this disappear. It hides only while the dialog
 * itself is open, to avoid stacking two update affordances on screen at
 * once; tapping it reopens the dialog.
 *
 * Positioned top-right, floating just below the header row rather than
 * flush with the status bar: every screen's own header (HomeScreen's
 * profile icon, ChatsScreen/GroupsScreen's header actions, TopBar's
 * rightSlot) already occupies that top-right corner up to roughly
 * insets.top + 56, so sitting flush there would overlap a real,
 * already-interactive button instead of merely sharing the corner.
 * Dropping below that band keeps it in the top-right corner without
 * covering chat content or any existing message/header controls.
 */
export function UpdateIndicator(): React.JSX.Element | null {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { updatePending, dialogVisible, openUpdateDialog } = useAppUpdate();

  if (!updatePending || dialogVisible) {
    return null;
  }

  return (
    <Pressable
      onPress={openUpdateDialog}
      accessibilityRole="button"
      accessibilityLabel="Update available"
      hitSlop={8}
      style={[
        styles.badge,
        theme.elevation[3],
        {
          top: insets.top + 64,
          backgroundColor: theme.colors.primary,
        },
      ]}
    >
      <Ionicons name="arrow-up" size={18} color={theme.colors.onPrimary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    right: 12,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    elevation: 12,
  },
});
