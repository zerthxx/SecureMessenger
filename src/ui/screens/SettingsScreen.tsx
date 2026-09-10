import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useAppUpdate, UpdateSheet } from '@/ui/screens/update';
import { useTheme, useThemePreference, type ThemePreference } from '@/ui/theme';
import { AppText, Card, Divider, ListRow, TopBar } from '@/ui/components';

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function SectionLabel({ text }: { text: string }): React.JSX.Element {
  return (
    <AppText variant="label" color="secondary" style={styles.sectionLabel}>
      {text}
    </AppText>
  );
}

function ThemePicker(): React.JSX.Element {
  const theme = useTheme();
  const { preference, setPreference } = useThemePreference();

  return (
    <View style={[styles.segmented, { backgroundColor: theme.colors.surfaceElevated, borderRadius: theme.radius.md }]}>
      {THEME_OPTIONS.map((option) => {
        const active = option.value === preference;
        return (
          <Pressable
            key={option.value}
            onPress={() => setPreference(option.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={[
              styles.segment,
              {
                backgroundColor: active ? theme.colors.surface : 'transparent',
                borderRadius: theme.radius.sm,
              },
              active ? theme.elevation[1] : null,
            ]}
          >
            <AppText variant="bodyMedium" color={active ? 'primary' : 'secondary'}>
              {option.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

export function SettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { installedVersion, status, checkForUpdate } = useAppUpdate();
  const [updateSheetVisible, setUpdateSheetVisible] = useState(false);

  const [readReceipts, setReadReceipts] = useState(true);
  const [notifications, setNotifications] = useState(true);
  const [lastSeen, setLastSeen] = useState(false);

  async function handleCheckForUpdates() {
    setUpdateSheetVisible(true);
    await checkForUpdate();
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <TopBar title="Settings" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <SectionLabel text="Appearance" />
        <Card padded={false} style={styles.card}>
          <View style={styles.cardPadding}>
            <ThemePicker />
          </View>
        </Card>

        <SectionLabel text="Account" />
        <Card padded={false} style={styles.card}>
          <View style={styles.rowPadding}>
            <ListRow icon="person-outline" label="Edit profile" onPress={() => {}} />
          </View>
          <Divider inset={60} />
          <View style={styles.rowPadding}>
            <ListRow icon="key-outline" label="Change passphrase" onPress={() => router.push('/change-password')} />
          </View>
        </Card>

        <SectionLabel text="Privacy" />
        <Card padded={false} style={styles.card}>
          <View style={styles.rowPadding}>
            <ListRow type="switch" icon="checkmark-done-outline" label="Read receipts" value={readReceipts} onValueChange={setReadReceipts} />
          </View>
          <Divider inset={60} />
          <View style={styles.rowPadding}>
            <ListRow type="switch" icon="time-outline" label="Show last seen" value={lastSeen} onValueChange={setLastSeen} />
          </View>
          <Divider inset={60} />
          <View style={styles.rowPadding}>
            <ListRow icon="ban-outline" label="Blocked contacts" subtitle="0 blocked" onPress={() => {}} />
          </View>
        </Card>

        <SectionLabel text="Notifications" />
        <Card padded={false} style={styles.card}>
          <View style={styles.rowPadding}>
            <ListRow type="switch" icon="notifications-outline" label="Push notifications" value={notifications} onValueChange={setNotifications} />
          </View>
        </Card>

        <SectionLabel text="About" />
        <Card padded={false} style={styles.card}>
          <View style={styles.rowPadding}>
            <ListRow
              icon="information-circle-outline"
              label="App version"
              subtitle={installedVersion ? `${installedVersion.versionName} (${installedVersion.versionCode})` : '—'}
              onPress={() => {}}
            />
          </View>
          <Divider inset={60} />
          <View style={styles.rowPadding}>
            <ListRow
              icon="cloud-download-outline"
              label="Check for updates"
              subtitle={status === 'checking' ? 'Checking…' : undefined}
              onPress={handleCheckForUpdates}
            />
          </View>
          <Divider inset={60} />
          <View style={styles.rowPadding}>
            <ListRow icon="document-text-outline" label="Legal & licenses" onPress={() => {}} />
          </View>
        </Card>
      </ScrollView>

      <UpdateSheet visible={updateSheetVisible} onClose={() => setUpdateSheetVisible(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 20,
    paddingBottom: 40,
  },
  sectionLabel: {
    marginTop: 20,
    marginBottom: 8,
    marginLeft: 4,
  },
  card: {
    paddingVertical: 4,
  },
  cardPadding: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  rowPadding: {
    paddingHorizontal: 16,
  },
  segmented: {
    flexDirection: 'row',
    padding: 4,
    gap: 4,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
  },
});
