export interface InstalledVersionInfo {
  /** Real PackageManager versionCode of the currently-installed APK — not app.json's version field. */
  versionCode: number;
  versionName: string;
}
