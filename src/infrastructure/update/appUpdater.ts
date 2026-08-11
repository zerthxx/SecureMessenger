// Thin wrapper around the local `app-updater` Expo module — same pattern
// as src/infrastructure/crypto/mlsCore.ts's relationship to mls-core.
// Every other file reaches the native update-installer surface only
// through this wrapper.
import { AppUpdaterModule } from '../../../modules/app-updater/src';
import type { InstalledVersionInfo } from '../../../modules/app-updater/src';

export type { InstalledVersionInfo };

export async function getInstalledVersion(): Promise<InstalledVersionInfo> {
  return AppUpdaterModule.getInstalledVersion();
}

export async function sha256File(fileUri: string): Promise<string> {
  return AppUpdaterModule.sha256File(fileUri);
}

export async function canRequestPackageInstalls(): Promise<boolean> {
  return AppUpdaterModule.canRequestPackageInstalls();
}

export async function openInstallPermissionSettings(): Promise<void> {
  return AppUpdaterModule.openInstallPermissionSettings();
}

/** `contentUri` must be a content:// URI (e.g. expo-file-system's `File.contentUri`). */
export async function installApk(contentUri: string): Promise<void> {
  return AppUpdaterModule.installApk(contentUri);
}
