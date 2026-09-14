import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

/*
 * Profile photos, kept in the same storage directory under `avatars/`.
 * Unlike voice blobs these are plain (already resized) images — profiles
 * aren't end-to-end encrypted — one file per upload id. The database only
 * holds the id (`users.avatar_id`); the bytes never go into Postgres.
 */

function avatarPath(avatarId: string): string {
  assertValidMediaId(avatarId);
  return path.join(env.MEDIA_STORAGE_DIR, 'avatars', `${avatarId}.img`);
}

let avatarDirReady: Promise<void> | null = null;

function ensureAvatarDir(): Promise<void> {
  if (!avatarDirReady) {
    avatarDirReady = mkdir(path.join(env.MEDIA_STORAGE_DIR, 'avatars'), { recursive: true }).then(() => undefined);
  }
  return avatarDirReady;
}

export const avatarBlobStorage = {
  async save(avatarId: string, bytes: Buffer): Promise<void> {
    await ensureAvatarDir();
    await writeFile(avatarPath(avatarId), bytes);
  },

  async read(avatarId: string): Promise<Buffer | null> {
    try {
      return await readFile(avatarPath(avatarId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },

  async remove(avatarId: string): Promise<void> {
    await rm(avatarPath(avatarId), { force: true });
  },
};
