import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import { env } from '../config/env.js';
import type { db as database } from '../db/client.js';
import { conversationMembers, devices } from '../db/schema.js';
import {
  buildCallEndedPush,
  buildIncomingCallPush,
  buildNewLoginPush,
  buildNewMessagePush,
  createFcmClient,
  parseServiceAccount,
  type FcmClient,
  type FcmDataMessage,
  type FcmMessage,
} from './fcm.js';
import { newLoginPushText, type NewLoginNotice } from './newLogin.js';

type Db = typeof database;
type Log = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

let client: FcmClient | null | undefined;
let configError: string | null = null;
let configErrorLogged = false;

function getClient(): FcmClient | null {
  if (client !== undefined) return client;
  if (!env.FCM_SERVICE_ACCOUNT_JSON) {
    client = null;
    return client;
  }
  try {
    client = createFcmClient(parseServiceAccount(env.FCM_SERVICE_ACCOUNT_JSON));
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
    client = null;
  }
  return client;
}

/** True once FCM_SERVICE_ACCOUNT_JSON holds a usable Firebase service account key. */
export function isPushDeliveryConfigured(): boolean {
  return getClient() !== null;
}

function reportConfigError(log: Log): void {
  if (configError && !configErrorLogged) {
    configErrorLogged = true;
    log.error({ reason: configError }, 'push delivery disabled: FCM_SERVICE_ACCOUNT_JSON is invalid');
  }
}

interface PushRecipient {
  id: string;
  pushToken: string | null;
}

/**
 * Sends one push per device. Never throws for delivery problems. Tokens FCM
 * reports as permanently invalid are cleared so they aren't retried on every
 * send.
 */
async function deliver(
  fcm: FcmClient,
  db: Db,
  log: Log,
  recipients: PushRecipient[],
  build: (token: string) => FcmMessage | FcmDataMessage,
): Promise<void> {
  await Promise.all(
    recipients.map(async (recipient) => {
      const token = recipient.pushToken;
      if (!token) return;
      try {
        const outcome = await fcm.send(build(token));
        if (outcome === 'invalid_token') {
          await db
            .update(devices)
            .set({ pushToken: null })
            .where(and(eq(devices.id, recipient.id), eq(devices.pushToken, token)));
          log.info({ deviceId: recipient.id }, 'cleared push token FCM reported as invalid');
        } else if (outcome !== 'sent') {
          log.warn({ deviceId: recipient.id, outcome }, 'push notification not delivered');
        }
      } catch (err) {
        log.warn({ err, deviceId: recipient.id }, 'push notification send failed');
      }
    }),
  );
}

/**
 * Sends a generic "New message" push to every signed-in device of every
 * *other* member of the conversation that has registered a push token.
 * Never throws for delivery problems — callers fire it without awaiting so
 * a slow or unavailable push provider can't fail or delay the message send.
 */
export async function notifyNewMessage({
  db,
  log,
  conversationId,
  senderUserId,
}: {
  db: Db;
  log: Log;
  conversationId: string;
  senderUserId: string;
}): Promise<void> {
  const fcm = getClient();
  if (!fcm) {
    reportConfigError(log);
    return;
  }

  const recipients = await db
    .select({ id: devices.id, pushToken: devices.pushToken })
    .from(devices)
    .innerJoin(conversationMembers, eq(conversationMembers.userId, devices.userId))
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        ne(devices.userId, senderUserId),
        isNull(devices.revokedAt),
        isNotNull(devices.pushToken),
      ),
    );

  await deliver(fcm, db, log, recipients, (token) => buildNewMessagePush(token, conversationId));
}

/** The account's signed-in devices with a push token, except those already connected over the realtime socket. */
async function unconnectedDevices(db: Db, userId: string, excludeDeviceIds: string[]): Promise<PushRecipient[]> {
  const rows = await db
    .select({ id: devices.id, pushToken: devices.pushToken })
    .from(devices)
    .where(and(eq(devices.userId, userId), isNull(devices.revokedAt), isNotNull(devices.pushToken)));
  return rows.filter((row) => !excludeDeviceIds.includes(row.id));
}

/**
 * Wakes the callee's devices that aren't connected, so a closed or
 * backgrounded app can show the incoming call (see buildIncomingCallPush).
 * Connected devices already got the invite over the realtime socket.
 */
export async function notifyIncomingCall({
  db,
  log,
  calleeUserId,
  excludeDeviceIds,
  callId,
  conversationId,
  media,
}: {
  db: Db;
  log: Log;
  calleeUserId: string;
  excludeDeviceIds: string[];
  callId: string;
  conversationId: string;
  media: 'audio' | 'video';
}): Promise<void> {
  const fcm = getClient();
  if (!fcm) {
    reportConfigError(log);
    return;
  }
  const recipients = await unconnectedDevices(db, calleeUserId, excludeDeviceIds);
  await deliver(fcm, db, log, recipients, (token) => buildIncomingCallPush(token, { callId, conversationId, media }));
}

/** Stops the ringing on devices that were woken for a call that has ended. */
export async function notifyCallEnded({
  db,
  log,
  userId,
  excludeDeviceIds,
  callId,
  reason,
}: {
  db: Db;
  log: Log;
  userId: string;
  excludeDeviceIds: string[];
  callId: string;
  reason: string;
}): Promise<void> {
  const fcm = getClient();
  if (!fcm) return;
  const recipients = await unconnectedDevices(db, userId, excludeDeviceIds);
  await deliver(fcm, db, log, recipients, (token) => buildCallEndedPush(token, { callId, reason }));
}

/** "New login detected" to the account's signed-in devices that the realtime alert didn't reach (and never the new one). */
export async function notifyNewLogin({
  db,
  log,
  userId,
  excludeDeviceIds,
  notice,
}: {
  db: Db;
  log: Log;
  userId: string;
  excludeDeviceIds: string[];
  notice: NewLoginNotice;
}): Promise<void> {
  const fcm = getClient();
  if (!fcm) {
    reportConfigError(log);
    return;
  }
  const recipients = await unconnectedDevices(db, userId, excludeDeviceIds);
  const text = newLoginPushText(notice);
  await deliver(fcm, db, log, recipients, (token) => buildNewLoginPush(token, text, notice.sessionId));
}
