import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/ui/theme';
import { AppText, Button, Sheet } from '@/ui/components';
import { useAppUpdate } from './UpdateContext';

export interface UpdateSheetProps {
  visible: boolean;
  onClose: () => void;
}

/**
 * Shared detail sheet for both entry points (the Home banner's "Download
 * Update" and Settings → About → "Check for updates") — one place that
 * shows the manifest's version/notes, download progress, verification,
 * and every error/permission state the update flow can land in.
 */
export function UpdateSheet({ visible, onClose }: UpdateSheetProps): React.JSX.Element {
  const theme = useTheme();
  const {
    status,
    manifest,
    installedVersion,
    progress,
    error,
    needsInstallPermission,
    checkForUpdate,
    startUpdate,
    requestInstallPermission,
  } = useAppUpdate();

  const busy = status === 'checking' || status === 'downloading' || status === 'verifying';

  return (
    <Sheet visible={visible} onClose={busy ? () => {} : onClose}>
      <View style={styles.content}>
        <View style={[styles.iconWrap, { backgroundColor: theme.colors.primaryMuted }]}>
          <Ionicons name="download-outline" size={26} color={theme.colors.primary} />
        </View>

        {status === 'checking' && (
          <>
            <AppText variant="title">Checking for updates…</AppText>
          </>
        )}

        {status === 'upToDate' && (
          <>
            <AppText variant="title">You&apos;re up to date.</AppText>
            {installedVersion ? (
              <AppText variant="body" color="secondary" style={styles.spaced}>
                SecureMessenger v{installedVersion.versionName}
              </AppText>
            ) : null}
            <View style={styles.action}>
              <Button label="Done" variant="secondary" onPress={onClose} fullWidth />
            </View>
          </>
        )}

        {status === 'available' && manifest && (
          <>
            <AppText variant="title">New update available</AppText>
            <AppText variant="bodyMedium" color="accent" style={styles.spaced}>
              SecureMessenger v{manifest.versionName}
            </AppText>
            {manifest.mandatory ? (
              <View style={[styles.mandatoryBadge, { backgroundColor: theme.colors.danger + '1A' }]}>
                <AppText variant="caption" style={{ color: theme.colors.danger }}>
                  This update is required to keep using SecureMessenger.
                </AppText>
              </View>
            ) : null}
            {manifest.releaseNotes ? (
              <AppText variant="body" color="secondary" style={styles.notes}>
                {manifest.releaseNotes}
              </AppText>
            ) : null}
            <View style={styles.action}>
              <Button label="Download Update" onPress={startUpdate} fullWidth />
            </View>
          </>
        )}

        {status === 'downloading' && (
          <>
            <AppText variant="title">Downloading update…</AppText>
            <View style={[styles.progressTrack, { backgroundColor: theme.colors.surfaceElevated }]}>
              <View
                style={[
                  styles.progressFill,
                  { backgroundColor: theme.colors.primary, width: `${Math.round(progress * 100)}%` },
                ]}
              />
            </View>
            <AppText variant="caption" color="secondary" style={styles.spaced}>
              {Math.round(progress * 100)}%
            </AppText>
          </>
        )}

        {status === 'verifying' && <AppText variant="title">Verifying update…</AppText>}

        {status === 'installerLaunched' && (
          <>
            <AppText variant="title">Ready to install</AppText>
            <AppText variant="body" color="secondary" style={styles.spaced}>
              Finish the update in the Android install screen that just opened. Your account and messages stay on
              this device.
            </AppText>
            <View style={styles.action}>
              <Button label="Done" variant="secondary" onPress={onClose} fullWidth />
            </View>
          </>
        )}

        {status === 'incompatibleSignature' && (
          <>
            <AppText variant="title">Manual reinstall required</AppText>
            <AppText variant="body" color="secondary" style={styles.spaced}>
              {manifest && installedVersion
                ? `SecureMessenger v${manifest.versionName} is signed with a new production signing key. Android won't install it in place over v${installedVersion.versionName}, which was signed with the old key — this is a platform security protection, not an app bug.`
                : "This update is signed with a new production key that Android won't install in place over the version on this device — a platform security protection, not an app bug."}
            </AppText>
            <AppText variant="body" color="secondary" style={styles.spaced}>
              To move to this version, back up anything you want to keep, then uninstall and reinstall
              SecureMessenger yourself. We will never uninstall the app or delete your data automatically.
            </AppText>
            <View style={styles.action}>
              <Button label="Close" variant="secondary" onPress={onClose} fullWidth />
            </View>
          </>
        )}

        {status === 'error' && (
          <>
            <AppText variant="title">{needsInstallPermission ? 'Permission needed' : "Couldn't update"}</AppText>
            <AppText variant="body" color="secondary" style={styles.spaced}>
              {error ?? 'Something went wrong.'}
            </AppText>
            <View style={styles.action}>
              {needsInstallPermission ? (
                <Button label="Open Settings" onPress={requestInstallPermission} fullWidth />
              ) : null}
              <Button label="Try again" onPress={manifest ? startUpdate : checkForUpdate} fullWidth />
            </View>
          </>
        )}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: {
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 12,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  spaced: {
    marginTop: 6,
    textAlign: 'center',
  },
  notes: {
    marginTop: 14,
    textAlign: 'center',
  },
  mandatoryBadge: {
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  action: {
    marginTop: 20,
    gap: 10,
  },
  progressTrack: {
    width: '100%',
    height: 8,
    borderRadius: 4,
    marginTop: 16,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 4,
  },
});
