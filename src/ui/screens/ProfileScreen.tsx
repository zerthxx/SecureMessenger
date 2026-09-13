import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { useTheme } from '@/ui/theme';
import { AppText, Avatar, Card, ConfirmModal, Divider, ListRow } from '@/ui/components';
import { useAuth } from './auth';

export function ProfileScreen(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, logout } = useAuth();
  const [signOutVisible, setSignOutVisible] = useState(false);

  const displayName = user?.displayName ?? '';
  const handle = user ? `@${user.username}` : '';

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
        <Avatar name={displayName} size="xl" />
        <AppText variant="headline" style={styles.name}>
          {displayName}
        </AppText>
        <AppText variant="body" color="secondary">
          {handle}
        </AppText>
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
  menuCard: {
    paddingVertical: 4,
  },
  rowPadding: {
    paddingHorizontal: 16,
  },
});
