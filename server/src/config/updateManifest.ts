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

// v0.7.0 — apkUrl/sha256 point at the signed release APK uploaded to GitHub
// Releases (zerthxx/SecureMessenger, tag v0.7.0); sha256 was computed locally
// and matches the GitHub asset's recorded digest. Signed with the same
// production keystore as v0.5.0/v0.6.0 (see keystores/KEYSTORE_INFO.md), so it
// installs in place over those versions. Devices still on a pre-v0.5.0
// production APK (signed with the original, lost key) must uninstall and
// reinstall. Update this whole object (and bump versionCode) the next time a
// signed release APK is cut and uploaded.
export const CURRENT_UPDATE_MANIFEST: UpdateManifest = {
  versionName: '0.7.0',
  versionCode: 7,
  apkUrl: 'https://github.com/zerthxx/SecureMessenger/releases/download/v0.7.0/app-release.apk',
  sha256: '6c534634a9c4d27e223e60e3d6c2a9a886ec66b9df2d3c3cfe97eb61661c79cb',
  releaseNotes: 'Hold the microphone to record voice messages, edit your display name, and use the new Privacy, Notifications and Appearance settings.',
  mandatory: false,
};
