/**
 * Every place an update's APK can be downloaded from, most preferred
 * first: the manifest's own `apkUrl` (GitHub Releases), then the same
 * release as served by this app's own backend (server/src/http/apkDownload.ts,
 * which only ever serves bytes matching the manifest's SHA-256). A 504 from
 * GitHub's asset CDN used to fail the whole update, even though the backend
 * had the identical file. Which source delivers the file doesn't affect
 * trust: the download is always checked against `sha256` before installing.
 *
 * HTTPS only. Pure (no imports) so it's unit tested (apkSources.test.ts).
 */

/** Must match the server's releaseApkFileName (server/src/lib/releaseApk.ts). */
const VERSION_NAME_RE = /^[0-9A-Za-z][0-9A-Za-z.-]*$/;

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function apkDownloadSources(manifest: { apkUrl: string; versionName: string }, apiBaseUrl: string): string[] {
  const sources: string[] = [];
  if (isHttps(manifest.apkUrl)) sources.push(manifest.apkUrl);
  if (VERSION_NAME_RE.test(manifest.versionName) && isHttps(apiBaseUrl)) {
    const mirror = `${apiBaseUrl.replace(/\/+$/, '')}/download/SecureMessenger-v${manifest.versionName}.apk`;
    if (!sources.includes(mirror)) sources.push(mirror);
  }
  return sources;
}
