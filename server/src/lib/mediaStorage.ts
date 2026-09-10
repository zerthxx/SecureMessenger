import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { env } from '../config/env.js';

/**
 * Local-disk storage for opaque voice-message ciphertext blobs (see
 * schema.ts's `media_objects` table doc). Every blob is already MLS
 * ciphertext by the time it reaches here — this module never sees, and
 * never needs to see, plaintext audio. Keyed strictly by the caller-
 * supplied `mediaId`, which callers must have already validated as a
 * UUID (see http/media.ts's zod schema) before calling in here — this
 * module does its own defensive re-check so a path-traversal payload
 * can never reach `path.join` even if a future caller forgets to.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertValidMediaId(mediaId: string): void {
  if (!UUID_RE.test(mediaId)) {
    throw new Error(`Invalid mediaId: ${mediaId}`);
  }
}

function blobPath(mediaId: string): string {
  assertValidMediaId(mediaId);
  return path.join(env.MEDIA_STORAGE_DIR, `${mediaId}.bin`);
}

let dirReady: Promise<void> | null = null;

function ensureStorageDir(): Promise<void> {
  if (!dirReady) {
    dirReady = mkdir(env.MEDIA_STORAGE_DIR, { recursive: true }).then(() => undefined);
  }
  return dirReady;
}

export async function saveMediaObject(mediaId: string, bytes: Buffer): Promise<void> {
  await ensureStorageDir();
  await writeFile(blobPath(mediaId), bytes);
}

export async function readMediaObject(mediaId: string): Promise<Buffer | null> {
  try {
    return await readFile(blobPath(mediaId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
