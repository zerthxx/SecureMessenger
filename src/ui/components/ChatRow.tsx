import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { Chat } from '@/domain/entities';
import { useTheme } from '@/ui/theme';
import { AppText } from './AppText';
import { Avatar } from './Avatar';
import { Badge } from './Badge';

export function ChatRow({
  chat,
  onPress,
  avatar,
}: {
  chat: Chat;
  onPress?: () => void;
  /** Replaces the default initials avatar, e.g. with a photo that opens the participant's profile. */
  avatar?: React.ReactNode;
}): React.JSX.Element {
  const theme = useTheme();
  const unread = chat.unreadCount > 0;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Chat with ${chat.participantName}`}
      style={({ pressed }) => [styles.container, pressed ? { opacity: 0.6 } : null]}
    >
      {avatar ?? <Avatar name={chat.participantName} online={chat.participantOnline} />}
      <View style={styles.textWrap}>
        <View style={styles.topLine}>
          <AppText variant="bodyMedium" numberOfLines={1} style={styles.name}>
            {chat.participantName}
          </AppText>
          <AppText variant="caption" color={unread ? 'accent' : 'secondary'}>
            {chat.timestampLabel}
          </AppText>
        </View>
        <View style={styles.bottomLine}>
          <AppText variant="body" color="secondary" numberOfLines={1} style={styles.message}>
            {chat.lastMessage}
          </AppText>
          {chat.muted ? (
            <Ionicons name="notifications-off-outline" size={14} color={theme.colors.textTertiary} style={styles.metaIcon} />
          ) : null}
          {chat.pinned ? (
            <Ionicons name="bookmark" size={13} color={theme.colors.textTertiary} style={styles.metaIcon} />
          ) : null}
          <Badge count={chat.unreadCount} />
        </View>
      </View>
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
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  name: {
    flex: 1,
    marginRight: 8,
  },
  bottomLine: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
    gap: 6,
  },
  message: {
    flex: 1,
  },
  metaIcon: {
    marginLeft: -2,
  },
});
