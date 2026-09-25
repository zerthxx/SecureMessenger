import { Directory, File, Paths } from 'expo-file-system';

import { downloadAvatar } from '../network/avatarApi';
import { statusOf, tryAcrossSources } from '../network/transientFailures';

/**
 * On-disk cache of profile photos, keyed by avatar id. The server issues a
 * fresh id for every upload and never reuses one, so a cached file can never
 * go stale: each photo is downloaded at most once per device, and a changed
 * photo simply arrives as a new id. Kept in the OS cache directory — the
 * system may purge it under storage pressure, which only costs a re-download.
 *
 * Not owner-scoped like voiceFiles.ts: profile photos are visible to every
 * signed-in user anyway, so sharing the cache between accounts on one device
 * reveals nothing an account couldn't already fetch.
 *
 * A download that can't complete never breaks anything: the caller keeps
 * showing initials (or the user's previous photo — see useAvatarImage).
 *
 * Layout: <cacheDirectory>/avatars/<avatarId>.img
 */

/**
 * After a download finally fails, how long that photo id is left alone so a
 * list of broken avatars can't loop requests: briefly after a temporary
 * failure (5xx, timeout, offline), much longer when the server says the
 * photo doesn't exist (404 — the id is stale; a profile refresh brings the
 * current one, see useAvatarImage).
 */
const RETRY_TRANSIENT_FAILURE_AFTER_MS = 30 * 1000;
const RETRY_MISSING_AFTER_MS = 10 * 60 * 1000;
/** Attempts per download when the server or network fails temporarily, with a short backoff in between. */
const DOWNLOAD_ATTEMPTS = 3;

const knownUris = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();
const failedUntil = new Map<string, number>();

function avatarFile(avatarId: string): File {
  return new File(new Directory(Paths.cache, 'avatars'), `${avatarId}.img`);
}

function writeAvatar(avatarId: string, bytes: Uint8Array): string {
  const directory = new Directory(Paths.cache, 'avatars');
  directory.create({ intermediates: true, idempotent: true });
  const file = avatarFile(avatarId);
  file.write(bytes);
  knownUris.set(avatarId, file.uri);
  failedUntil.delete(avatarId);
  return file.uri;
}

/** The local `file://` uri of an already-cached photo, or null. Synchronous, so a cached avatar renders on the first frame. */
export function getCachedAvatarUri(avatarId: string): string | null {
  const known = knownUris.get(avatarId);
  if (known) return known;
  try {
    const file = avatarFile(avatarId);
    if (file.exists) {
      knownUris.set(avatarId, file.uri);
      return file.uri;
    }
  } catch {
    // Unreadable cache entry — treated as a miss and downloaded again.
  }
  return null;
}

/**
 * Resolves a user's photo to a local uri, downloading it only if it isn't
 * cached. Concurrent requests for one id share a single download. A
 * temporary failure (5xx such as a 504 from the proxy, a timeout, no
 * connection) is retried a couple of times with backoff; a 404 is not.
 */
export function loadAvatar(userId: string, avatarId: string): Promise<string> {
  const cached = getCachedAvatarUri(avatarId);
  if (cached) return Promise.resolve(cached);

  const pending = inFlight.get(avatarId);
  if (pending) return pending;

  const blockedUntil = failedUntil.get(avatarId);
  if (blockedUntil !== undefined && Date.now() < blockedUntil) {
    return Promise.reject(new Error('Profile photo recently failed to load.'));
  }

  const download = tryAcrossSources(['server'], () => downloadAvatar(userId, avatarId), {
    maxRounds: DOWNLOAD_ATTEMPTS,
    baseDelayMs: 1000,
    maxDelayMs: 4000,
  })
    .then((bytes) => writeAvatar(avatarId, bytes))
    .catch((err: unknown) => {
      const missing = statusOf(err) === 404;
      failedUntil.set(avatarId, Date.now() + (missing ? RETRY_MISSING_AFTER_MS : RETRY_TRANSIENT_FAILURE_AFTER_MS));
      throw err;
    })
    .finally(() => inFlight.delete(avatarId));
  inFlight.set(avatarId, download);
  return download;
}

/** Stores a photo the user just uploaded, so the uploader never downloads their own photo back. */
export function primeAvatar(avatarId: string, bytes: Uint8Array): void {
  try {
    writeAvatar(avatarId, bytes);
  } catch {
    // Only an optimization — the photo is downloaded on first display instead.
  }
}
