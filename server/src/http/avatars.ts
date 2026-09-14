import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { AVATAR_IMAGE_TYPES, AVATAR_MAX_BYTES, detectAvatarImageType, type ProfileStore } from '../lib/profile.js';
import { replyIfRateLimited } from '../lib/rateLimit.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AvatarAuth {
  userId: string;
  deviceId: string;
}

/** Where photo bytes live — MEDIA_STORAGE_DIR/avatars in production (lib/mediaStorage.ts), a Map in tests. */
export interface AvatarBlobStore {
  save(avatarId: string, bytes: Buffer): Promise<void>;
  read(avatarId: string): Promise<Buffer | null>;
  remove(avatarId: string): Promise<void>;
}

export interface AvatarRouteOptions {
  /** Same Bearer-token check as the voice media routes (http/media.ts). */
  authenticate(req: FastifyRequest): Promise<AvatarAuth | null>;
  isDeviceActive(deviceId: string): Promise<boolean>;
  profiles: Pick<ProfileStore, 'findById' | 'setAvatar'>;
  blobs: AvatarBlobStore;
}

/**
 * Profile photos, over plain HTTP rather than tRPC for the same reason as
 * voice clips: binary bodies don't belong in the JSON batch transport.
 *
 *   PUT    /avatars                      set the caller's photo (raw image body)
 *   DELETE /avatars                      remove the caller's photo
 *   GET    /avatars/:userId/:avatarId    fetch a user's current photo
 *
 * Every route requires a signed-in user, checked in `onRequest` — before
 * any body is read, so an unauthenticated client can't make the server
 * buffer an upload. A photo id is random and never reused, so its bytes are
 * immutable and clients may cache them indefinitely; only the user's
 * current id is served, so a replaced or removed photo stops resolving.
 */
export async function avatarRoutes(app: FastifyInstance, options: AvatarRouteOptions) {
  const { authenticate, isDeviceActive, profiles, blobs } = options;
  const authByRequest = new WeakMap<FastifyRequest, AvatarAuth>();

  app.addContentTypeParser([...AVATAR_IMAGE_TYPES], { parseAs: 'buffer', bodyLimit: AVATAR_MAX_BYTES }, (_req, body, done) =>
    done(null, body),
  );

  app.addHook('onRequest', async (req, reply) => {
    const auth = await authenticate(req);
    if (!auth) {
      reply.status(401).send({ error: 'Authentication required' });
      return reply;
    }
    authByRequest.set(req, auth);
  });

  function authOf(req: FastifyRequest): AvatarAuth {
    const auth = authByRequest.get(req);
    if (!auth) throw new Error('avatar route reached without authentication');
    return auth;
  }

  /** Deleting a replaced photo is cleanup, not part of the request's success — a failure only leaves an unreferenced file behind. */
  async function removeQuietly(req: FastifyRequest, avatarId: string): Promise<void> {
    try {
      await blobs.remove(avatarId);
    } catch (err) {
      req.log.warn({ err, avatarId }, 'failed to delete replaced profile photo');
    }
  }

  app.put('/', async (req, reply) => {
    const auth = authOf(req);
    if (replyIfRateLimited(reply, `avatars:write:user:${auth.userId}`, 10, 10 * 60 * 1000)) return;
    if (!(await isDeviceActive(auth.deviceId))) {
      return reply.status(401).send({ error: 'This device has been signed out.' });
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.status(400).send({ error: 'Expected a non-empty image body.' });
    }
    // The declared type only picks the parser; the bytes decide what the file is.
    const declaredType = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
    const detectedType = detectAvatarImageType(body);
    if (!detectedType || detectedType !== declaredType) {
      return reply.status(415).send({ error: 'Profile photos must be JPEG, PNG or WebP images.' });
    }

    const avatarId = randomUUID();
    await blobs.save(avatarId, body);
    const result = await profiles.setAvatar(auth.userId, avatarId);
    if (!result) {
      await removeQuietly(req, avatarId);
      return reply.status(401).send({ error: 'Authentication required' });
    }
    if (result.previousAvatarId) await removeQuietly(req, result.previousAvatarId);

    req.log.info({ userId: auth.userId, byteSize: body.length }, 'profile photo updated');
    return reply.status(201).send({ avatarId });
  });

  app.delete('/', async (req, reply) => {
    const auth = authOf(req);
    if (replyIfRateLimited(reply, `avatars:write:user:${auth.userId}`, 10, 10 * 60 * 1000)) return;
    if (!(await isDeviceActive(auth.deviceId))) {
      return reply.status(401).send({ error: 'This device has been signed out.' });
    }

    const result = await profiles.setAvatar(auth.userId, null);
    if (!result) return reply.status(401).send({ error: 'Authentication required' });
    if (result.previousAvatarId) await removeQuietly(req, result.previousAvatarId);

    req.log.info({ userId: auth.userId }, 'profile photo removed');
    return reply.send({ avatarId: null });
  });

  app.get<{ Params: { userId: string; avatarId: string } }>('/:userId/:avatarId', async (req, reply) => {
    const auth = authOf(req);
    const { userId, avatarId } = req.params;
    if (!UUID_RE.test(userId) || !UUID_RE.test(avatarId)) {
      return reply.status(400).send({ error: 'Invalid id' });
    }
    // Generous: a chat list shows many avatars, but clients cache each id once.
    if (replyIfRateLimited(reply, `avatars:read:device:${auth.deviceId}`, 300, 60 * 1000)) return;

    const profile = await profiles.findById(userId.toLowerCase());
    if (!profile || profile.avatarId !== avatarId.toLowerCase()) {
      return reply.status(404).send({ error: 'Not found' });
    }
    const bytes = await blobs.read(profile.avatarId);
    const type = bytes ? detectAvatarImageType(bytes) : null;
    if (!bytes || !type) return reply.status(404).send({ error: 'Not found' });

    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.type(type).send(bytes);
  });
}
