import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import licenseData from '@/data/licenses.json';
import { AppText, Divider, ListRow } from '@/ui/components';
import { useAppUpdate } from '@/ui/screens/update';
import { SectionLabel, SettingsCard, SettingsRow, SettingsScreenFrame } from './SettingsSections';

interface PackageLicense {
  name: string;
  version: string;
  license: string;
  repository: string | null;
  licenseTextIds: string[];
}

interface LicenseData {
  javascript: PackageLicense[];
  native: PackageLicense[];
  licenseTexts: Record<string, string>;
}

// Generated from installed package metadata by scripts/generate-licenses.mjs (npm run licenses).
const data = licenseData as LicenseData;

function LicenseGroup({ title, packages }: { title: string; packages: PackageLicense[] }): React.JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <>
      <SectionLabel text={`${title} (${packages.length})`} />
      <SettingsCard>
        {packages.map((pkg, index) => {
          const key = `${pkg.name}@${pkg.version}`;
          const open = expanded === key;
          return (
            <View key={key}>
              {index > 0 ? <Divider inset={16} /> : null}
              <SettingsRow>
                <ListRow label={`${pkg.name} ${pkg.version}`} subtitle={pkg.license} onPress={() => setExpanded(open ? null : key)} />
              </SettingsRow>
              {open ? (
                <View style={styles.details}>
                  {pkg.repository ? (
                    <AppText variant="caption" color="secondary" selectable>
                      {pkg.repository}
                    </AppText>
                  ) : null}
                  {pkg.licenseTextIds.length > 0 ? (
                    pkg.licenseTextIds.map((id) => (
                      <AppText key={id} variant="caption" selectable>
                        {data.licenseTexts[id]}
                      </AppText>
                    ))
                  ) : (
                    <AppText variant="caption" color="secondary">
                      This package declares the {pkg.license} license but doesn't include a license file in its published package.
                    </AppText>
                  )}
                </View>
              ) : null}
            </View>
          );
        })}
      </SettingsCard>
    </>
  );
}

export function LegalLicensesScreen(): React.JSX.Element {
  const { installedVersion } = useAppUpdate();

  return (
    <SettingsScreenFrame title="Legal & licenses">
      <SectionLabel text="SecureMessenger" />
      <SettingsCard>
        <View style={styles.details}>
          <AppText variant="bodyMedium">
            Secure Messenger{installedVersion ? ` ${installedVersion.versionName} (${installedVersion.versionCode})` : ''}
          </AppText>
          <AppText variant="caption" color="secondary">
            No terms of service or privacy policy have been published for this app yet.
          </AppText>
        </View>
      </SettingsCard>

      <LicenseGroup title="App libraries" packages={data.javascript} />
      <LicenseGroup title="Encryption engine (Rust)" packages={data.native} />

      <AppText variant="caption" color="tertiary" style={styles.footnote}>
        Listed from each package's own published metadata. The libraries these packages depend on are distributed under their own
        licenses.
      </AppText>
    </SettingsScreenFrame>
  );
}

const styles = StyleSheet.create({
  details: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
  },
  footnote: {
    marginTop: 16,
    marginHorizontal: 4,
  },
});
