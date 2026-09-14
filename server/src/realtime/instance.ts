import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { decodeJwt } from 'jose';

import { db } from '../db/client.js';
import { conversationMembers, conversations, devices } from '../db/schema.js';
import type { RealtimeRouteOptions } from '../http/realtime.js';
import { notifyCallEnded, notifyIncomingCall } from '../lib/pushDelivery.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { CallRegistry } from './callRegistry.js';
import { RealtimeHub } from './hub.js';

/**
 * The process-wide realtime state (one server instance — see hub.ts) and its
 * wiring to the database, access tokens and push delivery. Everything with
 * logic lives in hub.ts / callRegistry.ts / http/realtime.ts, which take
 * these as injected dependencies and are tested without them.
 */

type Log = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

let log: Log = { info: () => {}, warn: () => {}, error: () => {} };

/** Called once by app.ts so push failures from call events are logged with the server's logger. */
export function attachRealtimeLogger(logger: Log): void {
  log = logger;
}

export const realtimeHub = new RealtimeHub();

export const callRegistry = new CallRegistry({
  toDevice: (deviceId, event) => realtimeHub.toDevice(deviceId, event),
  toUser: (userId, event, options) => realtimeHub.toUser(userId, event, options),
  wakeCallee: (call, connectedDeviceIds) => {
    notifyIncomingCall({
      db,
      log,
      calleeUserId: call.calleeUserId,
      excludeDeviceIds: connectedDeviceIds,
      callId: call.callId,
      conversationId: call.conversationId,
      media: call.media,
    }).catch((err: unknown) => log.warn({ err }, 'incoming call push failed'));
  },
  cancelWake: (call, reason) => {
    notifyCallEnded({
      db,
      log,
      userId: call.calleeUserId,
      excludeDeviceIds: realtimeHub.connectedDeviceIds(call.calleeUserId),
      callId: call.callId,
      reason,
    }).catch((err: unknown) => log.warn({ err }, 'call ended push failed'));
  },
});

async function authenticate(token: string) {
  const verified = await verifyAccessToken(token);
  if (!verified) return null;
  const { exp } = decodeJwt(token); // already signature-verified above
  return { ...verified, expiresAt: (exp ?? 0) * 1000 };
}

async function isDeviceActive(deviceId: string): Promise<boolean> {
  const [device] = await db.select({ revokedAt: devices.revokedAt }).from(devices).where(eq(devices.id, deviceId)).limit(1);
  return !!device && !device.revokedAt;
}

/** Calls are 1:1: only a member of a direct conversation can call, and only its other member. */
async function findCallee(conversationId: string, userId: string): Promise<string | null> {
  const members = await db
    .select({ userId: conversationMembers.userId, type: conversations.type })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(eq(conversationMembers.conversationId, conversationId));
  if (!members.some((member) => member.userId === userId)) return null;
  const others = members.filter((member) => member.userId !== userId);
  if (others.length !== 1 || others[0]?.type !== 'direct') return null;
  return others[0].userId;
}

export function createRealtimeRouteOptions(): RealtimeRouteOptions {
  return { hub: realtimeHub, calls: callRegistry, authenticate, isDeviceActive, findCallee };
}

/**
 * Tells connected devices that a conversation has new rows, so an open chat
 * syncs immediately instead of on its next poll. Carries only the
 * conversation id. A Welcome goes to the one device it is addressed to; an
 * application message to every member's connected devices except the one
 * that sent it.
 */
export async function publishConversationUpdated({
  conversationId,
  senderDeviceId,
  recipientDeviceId,
}: {
  conversationId: string;
  senderDeviceId: string;
  recipientDeviceId: string | null;
}): Promise<void> {
  const event = { type: 'conversation.updated', conversationId } as const;
  if (recipientDeviceId) {
    realtimeHub.toDevice(recipientDeviceId, event);
    return;
  }
  const members = await db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, conversationId));
  for (const member of members) {
    realtimeHub.toUser(member.userId, event, { exceptDeviceId: senderDeviceId });
  }
}
