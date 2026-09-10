import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { db } from '../db/client.js';
import { conversationMembers, devices, mediaObjects } from '../db/schema.js';
import { checkRateLimit, RateLimitExceededError } from '../lib/rateLimit.js';
import { readMediaObject, saveMediaObject } from '../lib/mediaStorage.js';
import { verifyAccessToken } from '../lib/tokens.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Max size of one voice-message ciphertext blob. See ChatContext's recording cap (2 minutes, low-bitrate mono AAC) — base64'd + MLS overhead comfortably fits well under this. */
const MAX_BLOB_BYTES = 3 * 1024 * 1024;

interface AuthResult {
  userId: string;
  deviceId: string;
}

/**
 * Plain Bearer-token auth, mirroring `trpc/context.ts` exactly (same
 * `verifyAccessToken` call, same signature+expiry-only check, no DB
 * hit) — this module exists because binary audio upload/download isn't
 * a good fit for tRPC's JSON transport, not because it needs different
 * auth semantics. Returns `null` (caller sends 401) rather than
 * throwing, since Fastify plain routes have no shared error-mapping
 * middleware the way tRPC procedures do.
 */
async function authenticate(req: FastifyRequest): Promise<AuthResult | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const verified = await verifyAccessToken(header.slice('Bearer '.length));
  if (!verified) return null;
  return verified;
}

/** Same revoked-device check as e2ee.ts's `assertCallerDeviceActive`, applied to the one mutating route (upload). */
async function isDeviceActive(deviceId: string): Promise<boolean> {
  const [device] = await db.select({ revokedAt: devices.revokedAt }).from(devices).where(eq(devices.id, deviceId)).limit(1);
  return !!device && !device.revokedAt;
}

/** Same `conversationMembers` membership check used identically by `sendMessage`/`fetchMessages` in the e2ee tRPC router — the authorization gate for every conversation-scoped operation in this app. */
async function isConversationMember(conversationId: string, userId: string): Promise<boolean> {
  const [membership] = await db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)))
    .limit(1);
  return !!membership;
}

function rateLimited(reply: FastifyReply, key: string, max: number, windowMs: number): boolean {
  try {
    checkRateLimit(key, max, windowMs);
    return false;
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      reply.status(429).send({ error: 'Too many attempts. Please try again shortly.' });
      return true;
    }
    throw err;
  }
}

/**
 * Voice-message media blobs. Every blob stored/served here is opaque
 * MLS ciphertext produced by the same `encryptMessage`/`decryptMessage`
 * calls used for ordinary text messages (see mlsCore.ts and this
 * app's ChatContext `sendVoiceMessage`/`downloadVoiceMessage`) — this
 * server never has, and never needs, the ability to decrypt audio
 * content. Both routes require the caller to be a member of the target
 * conversation, checked the same way every other conversation-scoped
 * endpoint in this codebase checks it.
 */
export async function mediaRoutes(app: FastifyInstance) {
  // Scoped to this plugin's encapsulation context only — the tRPC/JSON
  // routes registered elsewhere are unaffected.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_BLOB_BYTES },
    (_req, body, done) => done(null, body),
  );

  app.post<{ Params: { conversationId: string } }>('/:conversationId', async (req, reply) => {
    const auth = await authenticate(req);
    if (!auth) return reply.status(401).send({ error: 'Authentication required' });

    const { conversationId } = req.params;
    if (!UUID_RE.test(conversationId)) return reply.status(400).send({ error: 'Invalid conversationId' });

    if (rateLimited(reply, `media:upload:device:${auth.deviceId}`, 30, 60 * 1000)) return;

    if (!(await isDeviceActive(auth.deviceId))) {
      return reply.status(401).send({ error: 'This device has been signed out.' });
    }
    if (!(await isConversationMember(conversationId, auth.userId))) {
      return reply.status(403).send({ error: 'Not a member of this conversation.' });
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.status(400).send({ error: 'Expected a non-empty application/octet-stream body.' });
    }

    const mediaId = randomUUID();
    await saveMediaObject(mediaId, body);
    await db.insert(mediaObjects).values({
      id: mediaId,
      conversationId,
      senderDeviceId: auth.deviceId,
      byteSize: body.length,
    });

    return reply.status(201).send({ mediaId });
  });

  app.get<{ Params: { conversationId: string; mediaId: string } }>('/:conversationId/:mediaId', async (req, reply) => {
    const auth = await authenticate(req);
    if (!auth) return reply.status(401).send({ error: 'Authentication required' });

    const { conversationId, mediaId } = req.params;
    if (!UUID_RE.test(conversationId) || !UUID_RE.test(mediaId)) {
      return reply.status(400).send({ error: 'Invalid id' });
    }

    if (rateLimited(reply, `media:download:device:${auth.deviceId}`, 120, 60 * 1000)) return;

    if (!(await isConversationMember(conversationId, auth.userId))) {
      return reply.status(403).send({ error: 'Not a member of this conversation.' });
    }

    const [row] = await db
      .select({ id: mediaObjects.id })
      .from(mediaObjects)
      .where(and(eq(mediaObjects.id, mediaId), eq(mediaObjects.conversationId, conversationId)))
      .limit(1);
    if (!row) return reply.status(404).send({ error: 'Not found' });

    const bytes = await readMediaObject(mediaId);
    if (!bytes) return reply.status(404).send({ error: 'Not found' });

    reply.header('Cache-Control', 'private, no-store');
    return reply.type('application/octet-stream').send(bytes);
  });
}
