import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '@/ui/theme';
import { AppText, Button } from '@/ui/components';
import { useAppUpdate, type UpdateStatus } from './UpdateContext';

const PROGRESS_STATUSES: UpdateStatus[] = [
  'downloading',
  'verifying',
  'installerLaunched',
  'incompatibleSignature',
  'error',
];

/**
 * The update prompt — mounted once at the app root (see app/_layout.tsx)
 * so it can appear regardless of which tab/screen is showing. Its
 * visibility is entirely driven by `UpdateContext.dialogVisible`: shown
 * automatically the first time an update is detected each session, shown
 * again whenever the persistent `UpdateIndicator` is tapped, and hidden
 * by "Later"/"Done" — closing it never marks the update as handled.
 * `UpdateContext.updatePending` (installed vs. manifest versionCode) is
 * the only thing that decides whether an update still needs attention;
 * this component only decides whether the *dialog* is currently open.
 *
 * IMPORTANT (see the Phase 7 render-failure report): the `<Modal>`
 * element below is ALWAYS mounted — this component must never early-
 * return `null` before reaching it. `visible` is a plain prop toggle,
 * exactly like `ConfirmModal`'s own proven pattern (see
 * ProfileScreen's always-rendered `<ConfirmModal visible={...} />`). A
 * `<Modal>` that mounts for the very first time already at
 * `visible={true}` raced Android's native Dialog attachment and silently
 * never composited on screen, despite JS state being entirely correct.
 * Keeping the Modal permanently in the tree from app start, only ever
 * toggling its `visible` prop, gives the native host view time to
 * attach before it's ever asked to show itself.
 */
export function UpdateDialog(): React.JSX.Element {
  const theme = useTheme();
  const {
    status,
    manifest,
    installedVersion,
    dialogVisible,
    progress,
    error,
    needsInstallPermission,
    startUpdate,
    requestInstallPermission,
    closeUpdateDialog,
  } = useAppUpdate();

  const showPrompt = dialogVisible && !!manifest && status === 'available';
  const showProgress = dialogVisible && !!manifest && PROGRESS_STATUSES.includes(status);
  const visible = showPrompt || showProgress;

  const mandatory = manifest?.mandatory ?? false;
  const busy = status === 'downloading' || status === 'verifying';
  // Non-dismissable while a mandatory update sits unactioned, or while a
  // download/verify is actually in flight (closing mid-download would
  // orphan the in-progress state with no way back to it). The persistent
  // indicator intentionally has no equivalent for mandatory updates —
  // the dialog itself never leaves the screen, so there's nothing for an
  // indicator to reopen. `incompatibleSignature` is always dismissable
  // regardless of `mandatory`: there is no automatic path forward, so
  // trapping the user in a non-dismissable dialog would help no one.
  const dismissable = (!mandatory && !busy) || status === 'incompatibleSignature';

  function handleUpdateNow() {
    startUpdate();
  }

  function handleLater() {
    closeUpdateDialog();
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={dismissable ? closeUpdateDialog : () => {}}
    >
      <View style={[styles.backdrop, { backgroundColor: theme.colors.overlay }]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={dismissable ? closeUpdateDialog : undefined}
          accessibilityLabel="Dismiss dialog"
        />
        <View style={[styles.card, theme.elevation[4], { backgroundColor: theme.colors.surface, borderRadius: theme.radius.lg }]}>
          {showPrompt && (
            <>
              <AppText variant="title">{mandatory ? 'Update required' : 'Update available'}</AppText>
              <AppText variant="body" color="secondary" style={styles.message}>
                A new version of SecureMessenger is available.
              </AppText>
              <View style={styles.actions}>
                {mandatory ? null : <Button label="Later" variant="ghost" onPress={handleLater} />}
                <Button label="Update now" onPress={handleUpdateNow} />
              </View>
            </>
          )}

          {showProgress && status === 'downloading' && (
            <>
              <AppText variant="title">Downloading update…</AppText>
              <View style={[styles.progressTrack, { backgroundColor: theme.colors.surfaceElevated }]}>
                <View
                  style={[styles.progressFill, { backgroundColor: theme.colors.primary, width: `${Math.round(progress * 100)}%` }]}
                />
              </View>
              <AppText variant="caption" color="secondary" style={styles.message}>
                {Math.round(progress * 100)}%
              </AppText>
            </>
          )}

          {showProgress && status === 'verifying' && <AppText variant="title">Verifying update…</AppText>}

          {showProgress && status === 'installerLaunched' && (
            <>
              <AppText variant="title">Ready to install</AppText>
              <AppText variant="body" color="secondary" style={styles.message}>
                Finish the update in the Android install screen that just opened. Your account and messages stay on
                this device.
              </AppText>
              <View style={styles.actions}>
                <Button label="Done" variant="secondary" onPress={closeUpdateDialog} />
              </View>
            </>
          )}

          {showProgress && status === 'incompatibleSignature' && (
            <>
              <AppText variant="title">Manual reinstall required</AppText>
              <AppText variant="body" color="secondary" style={styles.message}>
                {manifest && installedVersion
                  ? `SecureMessenger v${manifest.versionName} is signed with a new production signing key. Android won't install it in place over v${installedVersion.versionName}, which was signed with the old key — this is a platform security protection, not an app bug.`
                  : "This update is signed with a new production key that Android won't install in place over the version on this device — a platform security protection, not an app bug."}
              </AppText>
              <AppText variant="body" color="secondary" style={styles.message}>
                To move to this version, back up anything you want to keep, then uninstall and reinstall
                SecureMessenger yourself. We will never uninstall the app or delete your data automatically.
              </AppText>
              <View style={styles.actions}>
                <Button label="Close" variant="secondary" onPress={closeUpdateDialog} />
              </View>
            </>
          )}

          {showProgress && status === 'error' && (
            <>
              <AppText variant="title">{needsInstallPermission ? 'Permission needed' : "Couldn't update"}</AppText>
              <AppText variant="body" color="secondary" style={styles.message}>
                {error ?? 'Something went wrong.'}
              </AppText>
              <View style={styles.actions}>
                {mandatory ? null : (
                  <Button label="Later" variant="ghost" onPress={closeUpdateDialog} />
                )}
                {needsInstallPermission ? (
                  <Button label="Open Settings" onPress={requestInstallPermission} />
                ) : null}
                <Button label="Try again" onPress={handleUpdateNow} />
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    padding: 20,
  },
  message: {
    marginTop: 8,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 20,
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
