import { API_BASE_URL } from '@/infrastructure/network/trpcClient';

export interface UpdateManifest {
  versionName: string;
  versionCode: number;
  apkUrl: string;
  sha256: string;
  releaseNotes: string;
  mandatory: boolean;
}

/**
 * Fetches the update manifest from the app's one hardcoded, build-time
 * production host (the same `API_BASE_URL` the tRPC client itself uses)
 * — never a user-suppliable or otherwise dynamic URL. Plain `fetch`
 * rather than the tRPC client: this is a bare public REST endpoint
 * (server/src/http/updateManifest.ts), not part of the tRPC router.
 */
export async function fetchUpdateManifest(): Promise<UpdateManifest> {
  const res = await fetch(`${API_BASE_URL}/update-manifest`);
  if (!res.ok) {
    throw new Error(`Update check failed (server returned ${res.status}).`);
  }
  const data: unknown = await res.json();
  if (!isUpdateManifestShape(data)) {
    throw new Error('Update check failed: the server response was malformed.');
  }
  return data;
}

function isUpdateManifestShape(value: unknown): value is UpdateManifest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.versionName === 'string' &&
    typeof v.versionCode === 'number' &&
    typeof v.apkUrl === 'string' &&
    typeof v.sha256 === 'string' &&
    typeof v.releaseNotes === 'string' &&
    typeof v.mandatory === 'boolean'
  );
}

/** A real, actionable update: strictly newer, and actually has something to download. */
export function isUpdateAvailable(manifest: UpdateManifest, installedVersionCode: number): boolean {
  return manifest.versionCode > installedVersionCode && manifest.apkUrl.length > 0 && manifest.sha256.length > 0;
}

/**
 * HTTPS-only gate on the APK URL, checked independently right before
 * every download attempt — defense in depth on top of the manifest
 * itself only ever being fetched from the one trusted host, in case a
 * future manifest source is ever less trustworthy than this one.
 */
export function isApkUrlTrusted(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
