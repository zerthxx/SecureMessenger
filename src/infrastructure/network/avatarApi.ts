// Profile photo upload/removal/download over the server's /avatars routes —
// plain `fetch` for the same reason as voiceMediaApi.ts: binary bodies don't
// belong in tRPC's JSON batch transport.
import { authorizedFetch } from './authorizedFetch';
import { API_BASE_URL } from './trpcClient';

const NETWORK_ERROR = "Couldn't reach the server. Check your connection and try again.";

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await authorizedFetch(url, init);
  } catch {
    // RN's fetch rejects with an unhelpful "Network request failed".
    throw new Error(NETWORK_ERROR);
  }
}

function photoChangeErrorMessage(status: number): string {
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
  const response = await send(`${API_BASE_URL}/avatars`, {
    method: 'PUT',
    headers: { 'content-type': photo.mimeType },
    // See voiceMediaApi.ts: RN's fetch accepts a Uint8Array body; only the DOM typing doesn't list it.
    body: photo.bytes as unknown as BodyInit,
  });
  if (!response.ok) throw new Error(photoChangeErrorMessage(response.status));
  return (await response.json()) as { avatarId: string };
}

export async function deleteAvatar(): Promise<void> {
  const response = await send(`${API_BASE_URL}/avatars`, { method: 'DELETE' });
  if (!response.ok) throw new Error(photoChangeErrorMessage(response.status));
}

export async function downloadAvatar(userId: string, avatarId: string): Promise<Uint8Array> {
  const response = await send(`${API_BASE_URL}/avatars/${userId}/${avatarId}`, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`Profile photo download failed (${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
