import { registerWebModule, NativeModule } from 'expo';

// Android-only feature (per the project's stated scope) — no web/APK
// install concept exists there. Throwing clearly here is safer than
// silently no-opping if this ever gets bundled for web by mistake.
class AppUpdaterModule extends NativeModule<{}> {
  getInstalledVersion(): Promise<never> {
    throw new Error('AppUpdater is not supported on web.');
  }
  sha256File(): Promise<never> {
    throw new Error('AppUpdater is not supported on web.');
  }
  canRequestPackageInstalls(): Promise<never> {
    throw new Error('AppUpdater is not supported on web.');
  }
  openInstallPermissionSettings(): Promise<never> {
    throw new Error('AppUpdater is not supported on web.');
  }
  installApk(): Promise<never> {
    throw new Error('AppUpdater is not supported on web.');
  }
}

export default registerWebModule(AppUpdaterModule, 'AppUpdaterModule');
