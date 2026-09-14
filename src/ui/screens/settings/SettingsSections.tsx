import type { PropsWithChildren, ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';

import { useTheme, useThemePreference, type ThemePreference } from '@/ui/theme';
import type { BirthdayVisibility, OwnProfile } from '@/domain/entities';
import { AppText, Card, Divider, ListRow, TopBar } from '@/ui/components';
import { useAuth } from '@/ui/screens/auth/AuthContext';
import { useNotifications, type NotificationsState } from './NotificationsProvider';
import { useSettingsPreferences } from './SettingsPreferencesProvider';

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/**
 * Back for every settings screen. Returns to wherever the screen was opened
 * from; with no history to return to (e.g. opened from a deep link) it falls
 * back to Profile, where all of these screens are reached from.
 */
export function useSettingsBack(): () => void {
  const router = useRouter();
  return () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/profile');
    }
  };
}

/** The top bar, background, and scroll padding every settings screen shares. */
export function SettingsScreenFrame({
  title,
  overlay,
  children,
}: PropsWithChildren<{ title: string; overlay?: ReactNode }>): React.JSX.Element {
  const theme = useTheme();
  const goBack = useSettingsBack();

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <TopBar title={title} onBack={goBack} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
      {overlay}
    </View>
  );
}

export function SectionLabel({ text }: { text: string }): React.JSX.Element {
  return (
    <AppText variant="label" color="secondary" style={styles.sectionLabel}>
      {text}
    </AppText>
  );
}

export function SettingsCard({ children }: PropsWithChildren): React.JSX.Element {
  return (
    <Card padded={false} style={styles.card}>
      {children}
    </Card>
  );
}

export function SettingsRow({ children }: PropsWithChildren): React.JSX.Element {
  return <View style={styles.rowPadding}>{children}</View>;
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

/** Settings → Privacy & Security → Devices: where the account is signed in. */
function DevicesRow(): React.JSX.Element {
  const router = useRouter();
  return (
    <ListRow
      icon="phone-portrait-outline"
      label="Devices"
      subtitle="Manage where you're signed in"
      // Cast: expo-router's generated route types pick up new routes on the next dev-server run.
      onPress={() => router.push('/settings/devices' as unknown as Href)}
    />
  );
}

function ChangePasswordRow(): React.JSX.Element {
  const router = useRouter();
  return <ListRow icon="key-outline" label="Change password" onPress={() => router.push('/change-password')} />;
}

export function AppearanceSection(): React.JSX.Element {
  return (
    <>
      <SectionLabel text="Appearance" />
      <SettingsCard>
        <View style={styles.cardPadding}>
          <ThemePicker />
        </View>
      </SettingsCard>
    </>
  );
}

export function AccountSection(): React.JSX.Element {
  const router = useRouter();
  return (
    <>
      <SectionLabel text="Account" />
      <SettingsCard>
        <SettingsRow>
          <ListRow icon="person-outline" label="Edit profile" onPress={() => router.push('/settings/edit-profile')} />
        </SettingsRow>
        <Divider inset={60} />
        <SettingsRow>
          <ChangePasswordRow />
        </SettingsRow>
        <Divider inset={60} />
        <SettingsRow>
          <DevicesRow />
        </SettingsRow>
      </SettingsCard>
    </>
  );
}

const BIRTHDAY_VISIBILITY_SUMMARY: Record<BirthdayVisibility, string> = {
  hidden: 'Only you can see it',
  month_day: 'Others see the day and month',
  full: 'Others see the full date',
};

function describeBirthdayPrivacy(profile: OwnProfile | null): string | undefined {
  if (!profile) return undefined;
  return profile.birthday ? BIRTHDAY_VISIBILITY_SUMMARY[profile.birthdayVisibility] : 'Not set';
}

export function PrivacySection(): React.JSX.Element {
  const router = useRouter();
  const { readReceipts, setReadReceipts, showLastSeen, setShowLastSeen } = useSettingsPreferences();
  const { profile } = useAuth();

  return (
    <>
      <SectionLabel text="Privacy" />
      <SettingsCard>
        <SettingsRow>
          <ListRow type="switch" icon="checkmark-done-outline" label="Read receipts" value={readReceipts} onValueChange={setReadReceipts} />
        </SettingsRow>
        <Divider inset={60} />
        <SettingsRow>
          <ListRow type="switch" icon="time-outline" label="Show last seen" value={showLastSeen} onValueChange={setShowLastSeen} />
        </SettingsRow>
        <Divider inset={60} />
        <SettingsRow>
          {/* Birthday visibility is stored with the profile on the server, so it's edited there. */}
          <ListRow
            icon="gift-outline"
            label="Birthday"
            subtitle={describeBirthdayPrivacy(profile)}
            onPress={() => router.push('/settings/edit-profile')}
          />
        </SettingsRow>
        <Divider inset={60} />
        <SettingsRow>
          <ListRow icon="ban-outline" label="Blocked contacts" onPress={() => router.push('/settings/blocked-contacts')} />
        </SettingsRow>
      </SettingsCard>
    </>
  );
}

/** Security-only settings for the dedicated Privacy & Security screen (the full Settings screen lists these under Account). */
export function SecuritySection(): React.JSX.Element {
  return (
    <>
      <SectionLabel text="Security" />
      <SettingsCard>
        <SettingsRow>
          <DevicesRow />
        </SettingsRow>
        <Divider inset={60} />
        <SettingsRow>
          <ChangePasswordRow />
        </SettingsRow>
      </SettingsCard>
    </>
  );
}

function describeNotifications(n: NotificationsState): string | null {
  if (n.permission === 'checking') return null;
  if (n.permission === 'blocked') return 'Notifications are turned off for SecureMessenger in your phone settings.';
  if (!n.enabled) return null;
  if (n.permission !== 'granted') return 'Notification permission wasn’t granted. Turn the switch on to ask again.';
  switch (n.delivery.state) {
    case 'registering':
      return 'Setting up notifications…';
    case 'unavailable':
      return /firebase/i.test(n.delivery.reason)
        ? 'This version of the app isn’t set up for background push notifications yet, so you’re only notified while the app is open.'
        : `Background push notifications aren’t available (${n.delivery.reason}). You’re still notified while the app is open.`;
    case 'registered':
      return n.delivery.serverCanDeliver
        ? 'You’ll be notified about new messages, even when the app is closed.'
        : 'The server can’t send push notifications yet, so you’re only notified while the app is open.';
    default:
      return null;
  }
}

export function NotificationsSection(): React.JSX.Element {
  const notifications = useNotifications();
  const status = describeNotifications(notifications);

  return (
    <>
      <SectionLabel text="Notifications" />
      <SettingsCard>
        <SettingsRow>
          <ListRow
            type="switch"
            icon="notifications-outline"
            label="Push notifications"
            value={notifications.active}
            onValueChange={(next) => void notifications.setEnabled(next)}
          />
        </SettingsRow>
        {status ? (
          <View style={styles.status}>
            <AppText variant="caption" color="secondary">
              {status}
            </AppText>
          </View>
        ) : null}
        {notifications.permission === 'blocked' ? (
          <>
            <Divider inset={60} />
            <SettingsRow>
              <ListRow icon="open-outline" label="Open phone settings" onPress={notifications.openSystemSettings} />
            </SettingsRow>
          </>
        ) : null}
      </SettingsCard>
    </>
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
  status: {
    paddingHorizontal: 16,
    paddingBottom: 12,
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
