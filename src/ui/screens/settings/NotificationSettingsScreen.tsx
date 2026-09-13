import { NotificationsSection, SettingsScreenFrame } from './SettingsSections';

export function NotificationSettingsScreen(): React.JSX.Element {
  return (
    <SettingsScreenFrame title="Notifications">
      <NotificationsSection />
    </SettingsScreenFrame>
  );
}
