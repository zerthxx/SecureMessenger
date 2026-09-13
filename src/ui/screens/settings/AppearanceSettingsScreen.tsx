import { AppearanceSection, SettingsScreenFrame } from './SettingsSections';

export function AppearanceSettingsScreen(): React.JSX.Element {
  return (
    <SettingsScreenFrame title="Appearance">
      <AppearanceSection />
    </SettingsScreenFrame>
  );
}
