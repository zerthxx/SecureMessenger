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

// v0.2.0 — the first release published through this update system.
// apkUrl/sha256 point at the actual signed release APK uploaded to
// GitHub Releases (zerthxx/SecureMessenger, tag v0.2.0); sha256 was
// computed locally from the same APK before upload and independently
// confirmed to match both GitHub's own reported asset digest and a
// fresh re-download's hash. Update this whole object (and bump
// versionCode) the next time a signed release APK is cut and uploaded.
export const CURRENT_UPDATE_MANIFEST: UpdateManifest = {
  versionName: '0.2.0',
  versionCode: 2,
  apkUrl: 'https://github.com/zerthxx/SecureMessenger/releases/download/v0.2.0/app-release.apk',
  sha256: '2900c487f5fbad5be850c3a94262bcb463c763f47c12d4470936bf02ba63d4ef',
  releaseNotes:
    'Fixes account-data isolation on logout/login, preserves encrypted messages across logout/login, prevents duplicate direct conversations, fixes a chat-list navigation race, and adds this in-app update system.',
  mandatory: false,
};
