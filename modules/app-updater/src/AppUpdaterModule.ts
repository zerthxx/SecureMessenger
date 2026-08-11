import { NativeModule, requireNativeModule } from 'expo';

import type { InstalledVersionInfo } from './AppUpdater.types';

declare class AppUpdaterModule extends NativeModule<{}> {
  getInstalledVersion(): Promise<InstalledVersionInfo>;
  /** `fileUri`: a file:// URI or plain path to a file this process wrote (e.g. the downloaded APK). Returns lowercase hex SHA-256. */
  sha256File(fileUri: string): Promise<string>;
  /** Whether this app currently has the OS-level "install unknown apps" grant. Always true below API 26. */
  canRequestPackageInstalls(): Promise<boolean>;
  /** Opens this app's specific "Install unknown apps" settings toggle. No-op below API 26. */
  openInstallPermissionSettings(): Promise<void>;
  /** `contentUri`: must be a content:// URI (e.g. from expo-file-system's File.contentUri). Launches Android's own package installer confirmation UI. */
  installApk(contentUri: string): Promise<void>;
}

export default requireNativeModule<AppUpdaterModule>('AppUpdater');
