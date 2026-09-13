import { PrivacySection, SecuritySection, SettingsScreenFrame } from './SettingsSections';

export function PrivacySecuritySettingsScreen(): React.JSX.Element {
  return (
    <SettingsScreenFrame title="Privacy & Security">
      <PrivacySection />
      <SecuritySection />
    </SettingsScreenFrame>
  );
}
