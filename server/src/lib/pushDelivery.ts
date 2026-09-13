import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import { env } from '../config/env.js';
import type { db as database } from '../db/client.js';
import { conversationMembers, devices } from '../db/schema.js';
import { buildNewMessagePush, createFcmClient, parseServiceAccount, type FcmClient } from './fcm.js';

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

/**
 * Sends a generic "New message" push to every signed-in device of every
 * *other* member of the conversation that has registered a push token.
 * Never throws for delivery problems — callers fire it without awaiting so
 * a slow or unavailable push provider can't fail or delay the message send.
 * Tokens FCM reports as permanently invalid are cleared so they aren't
 * retried on every message.
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
    if (configError && !configErrorLogged) {
      configErrorLogged = true;
      log.error({ reason: configError }, 'push delivery disabled: FCM_SERVICE_ACCOUNT_JSON is invalid');
    }
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

  await Promise.all(
    recipients.map(async (recipient) => {
      const token = recipient.pushToken;
      if (!token) return;
      try {
        const outcome = await fcm.send(buildNewMessagePush(token, conversationId));
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
