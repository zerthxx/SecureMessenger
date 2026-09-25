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
import { API_BASE_URL } from '@/infrastructure/network/trpcClient';
import { tryAcrossSources, updateDownloadFailureMessage } from '@/infrastructure/network/transientFailures';
import { apkDownloadSources } from '@/infrastructure/update/apkSources';
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
 * Transient failures (a CDN answering 502/503/504, dropped connections,
 * HTTP/2 stream resets like REFUSED_STREAM, timeouts) are common enough on
 * real networks that one failed attempt shouldn't surface an error. Each
 * round tries every source (see apkSources.ts) — so a 504 from GitHub's
 * asset CDN falls straight through to the same file on our own server —
 * and rounds are separated by a growing, jittered backoff. A source that
 * answers 404/403 is not asked again. Previously four attempts ~7 seconds
 * apart went to GitHub only, and the raw native error was shown.
 */
const DOWNLOAD_ROUNDS = 4;
const RETRY_BASE_DELAY_MS = 2000;
const RETRY_MAX_DELAY_MS = 15000;

/**
 * Downloads the update APK from the first source that delivers it. Every
 * attempt starts by discarding any leftover partial file at `destination`,
 * so a stream reset never leaves a corrupt half-downloaded APK mistaken for
 * a complete one (whether by this retry loop or by a subsequent app
 * session). Does not touch SHA-256 verification or HTTPS enforcement —
 * both still happen exactly as before, after a download completes here.
 */
async function downloadApk(
  sources: readonly string[],
  destination: File,
  options: {
    onProgress: (data: { bytesWritten: number; totalBytes: number }) => void;
    onAttemptStart?: () => void;
  },
): Promise<File> {
  try {
    return await tryAcrossSources(
      sources,
      async (url) => {
        if (destination.exists) destination.delete();
        options.onAttemptStart?.();
        return File.downloadFileAsync(url, destination, { idempotent: true, onProgress: options.onProgress });
      },
      { maxRounds: DOWNLOAD_ROUNDS, baseDelayMs: RETRY_BASE_DELAY_MS, maxDelayMs: RETRY_MAX_DELAY_MS },
    );
  } catch (err) {
    if (destination.exists) destination.delete();
    throw err;
  }
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

      const sources = apkDownloadSources(manifest, API_BASE_URL).filter(isApkUrlTrusted);
      const downloaded = await downloadApk(sources, destination, {
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
        sources: apkDownloadSources(manifest, API_BASE_URL),
        name: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        cause: err instanceof Error ? err.cause : undefined,
      });
      setStatus('error');
      // A plain explanation (e.g. "temporarily unavailable (error 504)"),
      // never the raw native rejection text.
      setError(updateDownloadFailureMessage(err));
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
