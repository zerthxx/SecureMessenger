import { useState } from 'react';
import { useRouter } from 'expo-router';

import { useAppUpdate, UpdateSheet } from '@/ui/screens/update';
import { Divider, ListRow } from '@/ui/components';
import {
  AccountSection,
  AppearanceSection,
  NotificationsSection,
  PrivacySection,
  SectionLabel,
  SettingsCard,
  SettingsRow,
  SettingsScreenFrame,
} from './settings';

/** The complete Settings screen ("All settings"): every section, in one place. */
export function SettingsScreen(): React.JSX.Element {
  const router = useRouter();
  const { installedVersion, status, checkForUpdate } = useAppUpdate();
  const [updateSheetVisible, setUpdateSheetVisible] = useState(false);

  async function handleCheckForUpdates() {
    setUpdateSheetVisible(true);
    await checkForUpdate();
  }

  return (
    <SettingsScreenFrame
      title="Settings"
      overlay={<UpdateSheet visible={updateSheetVisible} onClose={() => setUpdateSheetVisible(false)} />}
    >
      <AppearanceSection />
      <AccountSection />
      <PrivacySection />
      <NotificationsSection />

      <SectionLabel text="About" />
      <SettingsCard>
        <SettingsRow>
          <ListRow
            icon="information-circle-outline"
            label="App version"
            subtitle={installedVersion ? `${installedVersion.versionName} (${installedVersion.versionCode})` : '—'}
            onPress={() => {}}
          />
        </SettingsRow>
        <Divider inset={60} />
        <SettingsRow>
          <ListRow
            icon="cloud-download-outline"
            label="Check for updates"
            subtitle={status === 'checking' ? 'Checking…' : undefined}
            onPress={handleCheckForUpdates}
          />
        </SettingsRow>
        <Divider inset={60} />
        <SettingsRow>
          <ListRow icon="document-text-outline" label="Legal & licenses" onPress={() => router.push('/settings/legal')} />
        </SettingsRow>
      </SettingsCard>
    </SettingsScreenFrame>
  );
}
