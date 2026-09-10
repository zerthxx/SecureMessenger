import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { File, Paths } from 'expo-file-system';

import {
  canRequestPackageInstalls,
  getInstalledVersion,
  installApk,
  isApkSignatureCompatible,
  openInstallPermissionSettings,
  sha256File,
  type InstalledVersionInfo,
} from '@/infrastructure/update/appUpdater';
import { fetchUpdateManifest, isApkUrlTrusted, isUpdateAvailable, type UpdateManifest } from '@/infrastructure/update/updateManifest';
import { initMessageStore } from '@/infrastructure/storage/messageStore';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'upToDate'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'installerLaunched'
  | 'incompatibleSignature'
  | 'error';

const DOWNLOAD_FILE_NAME = 'securemessenger-update.apk';

/**
 * Transient failures (dropped connections, HTTP/2 stream resets like
 * REFUSED_STREAM, timeouts) are common enough on real networks — and on
 * some devices/carriers in particular — that a single failed attempt
 * shouldn't surface an error to the user. Retried with a short exponential
 * backoff; only the final attempt's failure is ever shown.
 */
const MAX_DOWNLOAD_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Downloads the update APK, retrying transient failures with backoff.
 * Every attempt — including the first — starts by discarding any
 * leftover partial file at `destination`, so a stream reset never leaves
 * a corrupt half-downloaded APK mistaken for a complete one (whether by
 * this retry loop or by a subsequent app session). Does not touch
 * SHA-256 verification or HTTPS enforcement — both still happen exactly
 * as before, after a download completes here.
 */
async function downloadApkWithRetry(
  url: string,
  destination: File,
  options: {
    onProgress: (data: { bytesWritten: number; totalBytes: number }) => void;
    onAttemptStart?: (attempt: number) => void;
  },
): Promise<File> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
    if (destination.exists) {
      destination.delete();
    }
    options.onAttemptStart?.(attempt);
    try {
      return await File.downloadFileAsync(url, destination, {
        idempotent: true,
        onProgress: options.onProgress,
      });
    } catch (err) {
      lastError = err;
      if (attempt === MAX_DOWNLOAD_ATTEMPTS) break;
      await delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }

  if (destination.exists) {
    destination.delete();
  }
  const lastMessage = lastError instanceof Error ? lastError.message : 'Unknown error';
  throw new Error(`Could not download the update after ${MAX_DOWNLOAD_ATTEMPTS} attempts (${lastMessage}).`);
}

interface UpdateContextValue {
  status: UpdateStatus;
  installedVersion: InstalledVersionInfo | null;
  manifest: UpdateManifest | null;
  /** 0-1, only meaningful while status === 'downloading'. */
  progress: number;
  error: string | null;
  /** True once a download+verify has succeeded and the system installer UI has been launched. */
  needsInstallPermission: boolean;
  /**
   * The sole source of truth for "an update is pending": derived purely
   * from comparing the actual installed versionCode against the server
   * manifest's versionCode. Never derived from — and never cleared by —
   * closing/dismissing the dialog. Stays true across "Later", app
   * restarts, and failed install attempts; only goes false once
   * `installedVersion.versionCode >= manifest.versionCode` is re-read
   * from Android PackageManager after an actual install.
   */
  updatePending: boolean;
  /** Whether the big "Update available" dialog is currently shown. */
  dialogVisible: boolean;
  checkForUpdate(): Promise<void>;
  startUpdate(): Promise<void>;
  requestInstallPermission(): Promise<void>;
  /** Reopens the dialog — used by the persistent update indicator. */
  openUpdateDialog(): void;
  /** Closes the dialog only; never marks the update as handled/dismissed. */
  closeUpdateDialog(): void;
}

const UpdateContext = createContext<UpdateContextValue | null>(null);

export function UpdateProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [installedVersion, setInstalledVersion] = useState<InstalledVersionInfo | null>(null);
  const [manifest, setManifest] = useState<UpdateManifest | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [needsInstallPermission, setNeedsInstallPermission] = useState(false);
  const [dialogVisible, setDialogVisible] = useState(false);

  const checkForUpdate = useCallback(async (): Promise<void> => {
    setStatus('checking');
    setError(null);
    try {
      const [installed, latest] = await Promise.all([getInstalledVersion(), fetchUpdateManifest()]);
      setInstalledVersion(installed);
      setManifest(latest);
      setStatus(isUpdateAvailable(latest, installed.versionCode) ? 'available' : 'upToDate');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Could not check for updates.');
    }
  }, []);

  // One quiet check per app session, on startup — never interrupts with
  // an alert/dialog on its own; the auto-open effect below decides
  // whether to actually surface the dialog once this resolves. A failure
  // here (offline, server hiccup) is silently left as 'idle'/'error'
  // rather than surfaced — only an explicit Settings → Check for updates
  // tap shows failures to the user.
  useEffect(() => {
    // Idempotent (CREATE TABLE IF NOT EXISTS) — called independently of
    // ChatProvider's own identical call so this provider's app_state
    // reads/writes never depend on mount order relative to ChatProvider.
    initMessageStore();
    checkForUpdate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-shows the big dialog the first time a given versionCode is seen
  // as available in this session — satisfies "when a new update is
  // detected, show the automatic dialog" without ever re-forcing it back
  // open just because the user pressed Later (dialogVisible is only ever
  // flipped true again from here once per newly-seen versionCode, or by
  // the user tapping the persistent indicator). Deliberately in-memory
  // only: no persisted "already prompted" flag survives a restart, so a
  // still-pending update prompts again — visibly — on the next cold
  // start, exactly as required.
  const promptedVersionRef = useRef<number | null>(null);
  useEffect(() => {
    if (status === 'available' && manifest && promptedVersionRef.current !== manifest.versionCode) {
      promptedVersionRef.current = manifest.versionCode;
      setDialogVisible(true);
    }
  }, [status, manifest]);

  const openUpdateDialog = useCallback(() => setDialogVisible(true), []);
  const closeUpdateDialog = useCallback(() => setDialogVisible(false), []);

  const requestInstallPermission = useCallback(async (): Promise<void> => {
    await openInstallPermissionSettings();
  }, []);

  const startUpdate = useCallback(async (): Promise<void> => {
    if (!manifest) return;

    if (!isApkUrlTrusted(manifest.apkUrl)) {
      setStatus('error');
      setError('Update download URL is not a trusted HTTPS address. Aborting.');
      return;
    }

    const hasPermission = await canRequestPackageInstalls();
    if (!hasPermission) {
      setNeedsInstallPermission(true);
      setStatus('error');
      setError('This device needs permission to install updates from SecureMessenger before downloading can continue.');
      return;
    }
    setNeedsInstallPermission(false);

    setStatus('downloading');
    setError(null);
    setProgress(0);

    try {
      const destination = new File(Paths.cache, DOWNLOAD_FILE_NAME);

      const downloaded = await downloadApkWithRetry(manifest.apkUrl, destination, {
        onAttemptStart: () => setProgress(0),
        onProgress: (data) => {
          if (data.totalBytes > 0) {
            setProgress(data.bytesWritten / data.totalBytes);
          }
        },
      });

      setStatus('verifying');
      const actualSha256 = await sha256File(downloaded.uri);
      if (actualSha256.toLowerCase() !== manifest.sha256.toLowerCase()) {
        downloaded.delete();
        setStatus('error');
        setError('Update verification failed. Please try again.');
        return;
      }

      // A verified-correct APK can still be signed with a different key
      // than what's already installed (e.g. a production signing-key
      // migration) — Android's installer would refuse it in place. Detect
      // that here, before ever launching the installer, so the app can
      // explain the real reason instead of the user hitting an
      // unexplained platform error. Never attempts to work around it: no
      // auto-uninstall, no bypassing signature verification.
      const signatureCompatible = await isApkSignatureCompatible(downloaded.uri);
      if (!signatureCompatible) {
        downloaded.delete();
        setStatus('incompatibleSignature');
        return;
      }

      const contentUri = downloaded.contentUri;
      await installApk(contentUri);
      // The Android installer UI has launched, but nothing has actually
      // been installed yet — the button press alone is not proof of
      // install. `updatePending` stays derived from `installedVersion`
      // (unchanged here) and only flips false once a fresh
      // `checkForUpdate()` — naturally triggered by this provider
      // remounting after the app restarts into the new version — re-reads
      // the real versionCode from PackageManager.
      setStatus('installerLaunched');
    } catch (err) {
      // Diagnostic only — does not affect the download, retry, SHA-256
      // verification, HTTPS validation, signing check, or install flow
      // above, all of which are unchanged. Exists because the app itself
      // otherwise never records anything beyond `err.message` (what the
      // UI already shows), which isn't enough to tell a network failure
      // apart from e.g. a native-module mismatch. `apkUrl` is a public
      // GitHub Releases URL, not a secret; nothing else here carries
      // tokens or credentials.
      console.error('[update] startUpdate failed', {
        apkUrl: manifest.apkUrl,
        name: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        cause: err instanceof Error ? err.cause : undefined,
      });
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Could not download the update.');
    }
  }, [manifest]);

  const updatePending = useMemo(
    () => !!installedVersion && !!manifest && isUpdateAvailable(manifest, installedVersion.versionCode),
    [installedVersion, manifest],
  );

  const value = useMemo<UpdateContextValue>(
    () => ({
      status,
      installedVersion,
      manifest,
      progress,
      error,
      needsInstallPermission,
      updatePending,
      dialogVisible,
      checkForUpdate,
      startUpdate,
      requestInstallPermission,
      openUpdateDialog,
      closeUpdateDialog,
    }),
    [
      status,
      installedVersion,
      manifest,
      progress,
      error,
      needsInstallPermission,
      updatePending,
      dialogVisible,
      checkForUpdate,
      startUpdate,
      requestInstallPermission,
      openUpdateDialog,
      closeUpdateDialog,
    ],
  );

  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

export function useAppUpdate(): UpdateContextValue {
  const ctx = useContext(UpdateContext);
  if (!ctx) {
    throw new Error('useAppUpdate must be used within an UpdateProvider');
  }
  return ctx;
}
