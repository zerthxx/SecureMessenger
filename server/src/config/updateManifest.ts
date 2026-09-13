/**
 * The single source of truth for "what is the latest production Android
 * release." Updated by hand as part of cutting a new release — see the
 * versioning process note in android/app/build.gradle's comments. This
 * project builds locally via `gradlew` (not `eas build`), so there is no
 * remote version registry to read from instead; this file *is* the
 * registry, served to clients by ../http/updateManifest.ts.
 *
 * Kept as literal, reviewable config rather than a database row: the
 * update manifest changes only when a human cuts a release (a code-review
 * event), not at runtime, and adding a DB table/admin UI for something
 * that changes a few times a year would be more machinery than the
 * problem needs.
 */
export interface UpdateManifest {
  /** Must match android/app/build.gradle's versionName for this release. */
  versionName: string;
  /** Must match android/app/build.gradle's versionCode for this release — this is what the client actually compares against. */
  versionCode: number;
  /**
   * HTTPS download URL for the signed release APK (a GitHub Releases
   * asset URL). Empty until a release has actually been published —
   * clients must never attempt a download when this is empty, even if a
   * versionCode comparison somehow suggested an update.
   */
  apkUrl: string;
  /** Lowercase hex SHA-256 of the exact APK bytes at apkUrl. Empty until a release has been published. */
  sha256: string;
  releaseNotes: string;
  /** Whether older versions must not be allowed to postpone this update. Defaults to false for every release unless explicitly set here. */
  mandatory: boolean;
}

// v0.6.0 — apkUrl/sha256 point at the actual signed release APK uploaded
// to GitHub Releases (zerthxx/SecureMessenger, tag v0.6.0); sha256 was
// computed locally from the same APK and independently confirmed against
// both the GitHub asset's recorded digest and a re-download of the
// published asset. Signed with the same production keystore as v0.5.0
// (see keystores/KEYSTORE_INFO.md), so unlike the v0.5.0 cut this *is* a
// normal in-place update for devices already running v0.5.0. Devices
// still on a pre-v0.5.0 production APK (signed with the original, lost
// key) remain unable to update in place and must uninstall and reinstall.
// Update this whole object (and bump versionCode) the next time a signed
// release APK is cut and uploaded.
export const CURRENT_UPDATE_MANIFEST: UpdateManifest = {
  versionName: '0.6.0',
  versionCode: 6,
  apkUrl: 'https://github.com/zerthxx/SecureMessenger/releases/download/v0.6.0/app-release.apk',
  sha256: '9ff8f267064ab0116d0c4046737dfe74ff7aea8a89f00e528e5bda2ca8975bbf',
  releaseNotes: 'Adds encrypted voice messages, plus security and reliability fixes.',
  mandatory: false,
};
