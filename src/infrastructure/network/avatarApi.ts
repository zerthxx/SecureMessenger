// Profile photo upload/removal/download over the server's /avatars routes —
// plain `fetch` for the same reason as voiceMediaApi.ts: binary bodies don't
// belong in tRPC's JSON batch transport.
import { authorizedFetch } from './authorizedFetch';
import { HttpStatusError, isTransientStatus, RequestTimeoutError } from './transientFailures';
import { API_BASE_URL } from './trpcClient';

const NETWORK_ERROR = "Couldn't reach the server. Check your connection and try again.";
/** A photo is at most a few hundred KB; past this the request is treated as failed rather than left hanging (it used to have no limit at all). */
const DOWNLOAD_TIMEOUT_MS = 15000;
const CHANGE_TIMEOUT_MS = 30000;
/** One retry of a photo upload/removal that hit a temporary server error (e.g. a 504 from the proxy). */
const CHANGE_RETRY_DELAY_MS = 1500;

async function send(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await authorizedFetch(url, { ...init, signal: controller.signal });
  } catch {
    if (controller.signal.aborted) throw new RequestTimeoutError('The server took too long to respond. Please try again.');
    // RN's fetch rejects with an unhelpful "Network request failed".
    throw new Error(NETWORK_ERROR);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Uploading or removing a photo, retried once after a temporary server
 * error. Both are safe to repeat: a repeated upload just replaces the photo
 * again (the server deletes the one it replaces), a repeated removal is a
 * no-op.
 */
async function sendPhotoChange(url: string, init: RequestInit): Promise<Response> {
  const response = await send(url, init, CHANGE_TIMEOUT_MS);
  if (!isTransientStatus(response.status)) return response;
  await new Promise((resolve) => setTimeout(resolve, CHANGE_RETRY_DELAY_MS));
  return send(url, init, CHANGE_TIMEOUT_MS);
}

function photoChangeErrorMessage(status: number): string {
  if (isTransientStatus(status) && status !== 429) {
    return `The server is temporarily unavailable, so your photo wasn't changed (error ${status}). Please try again in a moment.`;
  }
  switch (status) {
    case 401:
      return 'Your session has expired. Please sign in again.';
    case 413:
      return 'That photo is too large. Please choose another one.';
    case 415:
      return "That file isn't a supported image. Please choose a JPEG or PNG photo.";
    case 429:
      return 'Too many photo changes. Please try again in a few minutes.';
    default:
      return `Could not update your profile photo (${status}). Please try again.`;
  }
}

/** Sets the signed-in user's profile photo. The server issues a new id for every upload. */
export async function uploadAvatar(photo: { bytes: Uint8Array; mimeType: string }): Promise<{ avatarId: string }> {
  const response = await sendPhotoChange(`${API_BASE_URL}/avatars`, {
    method: 'PUT',
    headers: { 'content-type': photo.mimeType },
    // See voiceMediaApi.ts: RN's fetch accepts a Uint8Array body; only the DOM typing doesn't list it.
    body: photo.bytes as unknown as BodyInit,
  });
  if (!response.ok) throw new Error(photoChangeErrorMessage(response.status));
  return (await response.json()) as { avatarId: string };
}

export async function deleteAvatar(): Promise<void> {
  const response = await sendPhotoChange(`${API_BASE_URL}/avatars`, { method: 'DELETE' });
  if (!response.ok) throw new Error(photoChangeErrorMessage(response.status));
}

/**
 * One download attempt, bounded by DOWNLOAD_TIMEOUT_MS. A non-2xx answer
 * becomes an HttpStatusError so the cache can tell "this photo doesn't
 * exist (anymore)" (404) from "the server is struggling" (5xx) — see
 * avatarCache.ts. Retrying is the caller's decision.
 */
export async function downloadAvatar(userId: string, avatarId: string): Promise<Uint8Array> {
  const response = await send(`${API_BASE_URL}/avatars/${userId}/${avatarId}`, { method: 'GET' }, DOWNLOAD_TIMEOUT_MS);
  if (!response.ok) {
    throw new HttpStatusError(response.status, `Profile photo download failed (${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
