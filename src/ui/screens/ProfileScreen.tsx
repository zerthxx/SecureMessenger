import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { formatIsoBirthday } from '@/core/utils/birthday';
import { useAvatarImage } from '@/ui/hooks/useAvatarImage';
import { useTheme } from '@/ui/theme';
import { AppText, Avatar, Button, Card, ConfirmModal, Divider, ListRow } from '@/ui/components';
import { useAuth } from './auth';

export function ProfileScreen(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, profile, logout } = useAuth();
  const [signOutVisible, setSignOutVisible] = useState(false);
  const avatarUri = useAvatarImage(user?.id, profile?.avatarId);

  const displayName = profile?.displayName ?? user?.displayName ?? '';
  const handle = user ? `@${user.username}` : '';
  const openEditProfile = () => router.push('/settings/edit-profile');

  const handleSignOut = async () => {
    try {
      await logout();
    } finally {
      setSignOutVisible(false);
      router.replace('/welcome');
    }
  };

  return (
    <ScrollView
      style={{ backgroundColor: theme.colors.background }}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + theme.spacing.xl }]}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.identity}>
        <Pressable onPress={openEditProfile} accessibilityRole="button" accessibilityLabel="Edit profile">
          <Avatar name={displayName} size="xl" imageUri={avatarUri} />
        </Pressable>
        <AppText variant="headline" style={styles.name}>
          {displayName}
        </AppText>
        <AppText variant="body" color="secondary">
          {handle}
        </AppText>
        {profile?.bio ? (
          <AppText variant="body" style={styles.bio}>
            {profile.bio}
          </AppText>
        ) : null}
        {profile?.birthday ? (
          <View style={styles.birthday}>
            <Ionicons name="gift-outline" size={14} color={theme.colors.textSecondary} />
            <AppText variant="caption" color="secondary">
              {formatIsoBirthday(profile.birthday)}
            </AppText>
          </View>
        ) : null}
        <View style={styles.editButton}>
          <Button label="Edit profile" variant="secondary" onPress={openEditProfile} />
        </View>
      </View>

      <Card padded={false} style={styles.menuCard}>
        <View style={styles.rowPadding}>
          <ListRow icon="shield-checkmark-outline" label="Privacy & Security" onPress={() => router.push('/settings/privacy')} />
        </View>
        <Divider inset={60} />
        <View style={styles.rowPadding}>
          <ListRow icon="notifications-outline" label="Notifications" onPress={() => router.push('/settings/notifications')} />
        </View>
        <Divider inset={60} />
        <View style={styles.rowPadding}>
          <ListRow icon="color-palette-outline" label="Appearance" onPress={() => router.push('/settings/appearance')} />
        </View>
        <Divider inset={60} />
        <View style={styles.rowPadding}>
          <ListRow icon="settings-outline" label="All settings" onPress={() => router.push('/settings')} />
        </View>
      </Card>

      <Card padded={false} style={styles.menuCard}>
        <View style={styles.rowPadding}>
          <ListRow icon="help-circle-outline" label="Help & feedback" onPress={() => router.push('/settings/help')} />
        </View>
        <Divider inset={60} />
        <View style={styles.rowPadding}>
          <ListRow icon="log-out-outline" label="Sign out" destructive onPress={() => setSignOutVisible(true)} />
        </View>
      </Card>

      <ConfirmModal
        visible={signOutVisible}
        title="Sign out?"
        message="You'll need to log in again to access your chats."
        confirmLabel="Sign out"
        destructive
        onConfirm={handleSignOut}
        onCancel={() => setSignOutVisible(false)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 20,
    paddingBottom: 40,
    gap: 20,
  },
  identity: {
    alignItems: 'center',
  },
  name: {
    marginTop: 14,
  },
  bio: {
    marginTop: 10,
    textAlign: 'center',
  },
  birthday: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
  },
  editButton: {
    marginTop: 14,
  },
  menuCard: {
    paddingVertical: 4,
  },
  rowPadding: {
    paddingHorizontal: 16,
  },
});
