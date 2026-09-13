import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';

import { CURRENT_UPDATE_MANIFEST, type UpdateManifest } from '../config/updateManifest.js';

/**
 * A local, SHA-256-verified copy of the release APK the update manifest
 * points at, so the server can hand it to browsers directly instead of
 * sending them through GitHub's 302 to a signed asset-host URL.
 *
 * Deliberately not a second source of truth: the bytes are fetched from
 * `CURRENT_UPDATE_MANIFEST.apkUrl` and kept only if they hash to
 * `CURRENT_UPDATE_MANIFEST.sha256` — the exact check the app itself runs
 * before installing. A mismatch is discarded, never served. Cutting a new
 * release (updating the manifest) automatically changes what this serves.
 *
 * Cached on the container's temp disk rather than the /data volume: the
 * APK can always be re-fetched and re-verified from the release, so it
 * doesn't need to survive a redeploy, and it stays out of the directory
 * that holds user voice-message blobs.
 */
export interface ReleaseApk {
  path: string;
  size: number;
  sha256: string;
}

const CACHE_DIR = path.join(os.tmpdir(), 'securemessenger-release-apk');
const FETCH_TIMEOUT_MS = 10 * 60 * 1000;
const SHA256_RE = /^[0-9a-f]{64}$/;
const VERSION_NAME_RE = /^[0-9A-Za-z][0-9A-Za-z.-]*$/;

/** The download filename for a manifest's release, e.g. `SecureMessenger-v0.6.0.apk`. */
export function releaseApkFileName(manifest: UpdateManifest = CURRENT_UPDATE_MANIFEST): string {
  if (!VERSION_NAME_RE.test(manifest.versionName)) {
    throw new Error(`Unsafe versionName for a download filename: ${manifest.versionName}`);
  }
  return `SecureMessenger-v${manifest.versionName}.apk`;
}

async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function provisionReleaseApk(manifest: UpdateManifest): Promise<ReleaseApk> {
  const expectedSha256 = manifest.sha256.toLowerCase();
  if (!manifest.apkUrl || !SHA256_RE.test(expectedSha256)) {
    throw new Error('The update manifest has no published release APK to serve.');
  }
  if (new URL(manifest.apkUrl).protocol !== 'https:') {
    throw new Error('The update manifest apkUrl is not HTTPS.');
  }

  await mkdir(CACHE_DIR, { recursive: true });
  const finalPath = path.join(CACHE_DIR, `${expectedSha256}.apk`);

  // A copy left by an earlier process in this same container is reused
  // only after re-hashing it — never trusted on filename alone.
  const existing = await stat(finalPath).catch(() => null);
  if (existing?.isFile()) {
    if ((await sha256OfFile(finalPath)) === expectedSha256) {
      return { path: finalPath, size: existing.size, sha256: expectedSha256 };
    }
    await rm(finalPath, { force: true });
  }

  const partPath = `${finalPath}.${process.pid}.${Date.now()}.part`;
  try {
    const res = await fetch(manifest.apkUrl, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok || !res.body) {
      throw new Error(`Fetching the release APK failed: HTTP ${res.status}`);
    }

    const hash = createHash('sha256');
    const hashing = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as unknown as NodeWebReadableStream<Uint8Array>),
      hashing,
      createWriteStream(partPath),
    );

    const actualSha256 = hash.digest('hex');
    if (actualSha256 !== expectedSha256) {
      throw new Error(`Release APK SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
    }
    await rename(partPath, finalPath);
  } catch (err) {
    await rm(partPath, { force: true });
    throw err;
  }

  const { size } = await stat(finalPath);
  return { path: finalPath, size, sha256: expectedSha256 };
}

let provisioning: Promise<ReleaseApk> | null = null;

/**
 * Resolves to the verified local APK, fetching it on first use. Concurrent
 * callers share one fetch; a failure is not cached, so the next request
 * retries.
 */
export function getReleaseApk(): Promise<ReleaseApk> {
  if (!provisioning) {
    provisioning = provisionReleaseApk(CURRENT_UPDATE_MANIFEST).catch((err: unknown) => {
      provisioning = null;
      throw err;
    });
  }
  return provisioning;
}
