import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { Group } from '@/domain/entities';
import { useTheme } from '@/ui/theme';
import { AppText } from './AppText';
import { Avatar } from './Avatar';
import { Badge } from './Badge';

export function GroupRow({ group, onPress }: { group: Group; onPress?: () => void }): React.JSX.Element {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Group ${group.name}`}
      style={({ pressed }) => [styles.container, pressed ? { opacity: 0.6 } : null]}
    >
      <Avatar name={group.name} size="lg" />
      <View style={styles.textWrap}>
        <View style={styles.topLine}>
          <AppText variant="bodyMedium" numberOfLines={1} style={styles.name}>
            {group.name}
          </AppText>
          {group.isPrivate ? <Ionicons name="lock-closed" size={13} color={theme.colors.textTertiary} /> : null}
        </View>
        <AppText variant="body" color="secondary">
          {group.memberCount} members · {group.lastActivityLabel}
        </AppText>
      </View>
      <Badge count={group.unreadCount} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  textWrap: {
    flex: 1,
  },
  topLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  name: {
    flexShrink: 1,
  },
});
