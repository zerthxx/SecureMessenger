// Binary upload/download for voice-message ciphertext blobs — deliberately
// plain `fetch`, not tRPC: the untyped/typed tRPC client in trpcClient.ts
// carries JSON over httpBatchLink, which is a poor fit for a multi-hundred-KB
// binary body. This module reuses that file's access-token/refresh state
// instead of duplicating it, so both clients always agree on "who is
// authenticated right now."
import { authorizedFetch } from './authorizedFetch';
import { API_BASE_URL } from './trpcClient';

export async function uploadVoiceBlob(conversationId: string, bytes: Uint8Array): Promise<{ mediaId: string }> {
  const response = await authorizedFetch(`${API_BASE_URL}/media/${conversationId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    // React Native's fetch polyfill accepts a Uint8Array body directly;
    // only the DOM `BodyInit` type (written for browsers) doesn't list
    // it, so this is a lib-typing gap, not a runtime concern.
    body: bytes as unknown as BodyInit,
  });
  if (!response.ok) {
    throw new Error(`Voice message upload failed (${response.status}).`);
  }
  const data = (await response.json()) as { mediaId: string };
  return data;
}

export async function downloadVoiceBlob(conversationId: string, mediaId: string): Promise<Uint8Array> {
  const response = await authorizedFetch(`${API_BASE_URL}/media/${conversationId}/${mediaId}`, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`Voice message download failed (${response.status}).`);
  }
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}
