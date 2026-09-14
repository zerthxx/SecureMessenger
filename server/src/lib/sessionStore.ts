import { and, desc, eq, gt, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';

import type { db as Db } from '../db/client.js';
import { devices, users } from '../db/schema.js';
import type { RevokeTarget, SessionStore } from './sessions.js';

/** Descriptive columns only — the refresh-token hash, push token and E2EE keys are never selected here. */
const sessionColumns = {
  id: devices.id,
  userId: devices.userId,
  name: devices.name,
  model: devices.model,
  platform: devices.platform,
  osVersion: devices.osVersion,
  appVersion: devices.appVersion,
  lastIpPrefix: devices.lastIpPrefix,
  createdAt: devices.createdAt,
  lastSeenAt: devices.lastSeenAt,
};

/** Exactly what signing out has always cleared: the refresh token (so it can't be exchanged again) and the push token. */
function terminatedFields() {
  return { revokedAt: new Date(), refreshTokenHash: null, refreshTokenExpiresAt: null, pushToken: null };
}

function targetCondition(target: RevokeTarget): SQL | undefined {
  if ('deviceIds' in target) return target.deviceIds.length > 0 ? inArray(devices.id, [...target.deviceIds]) : sql`false`;
  if ('allExcept' in target) return ne(devices.id, target.allExcept);
  return undefined;
}

/** The Postgres-backed SessionStore (the `devices` table is the session table). */
export function createDbSessionStore(db: typeof Db): SessionStore {
  return {
    async findState(deviceId) {
      const [row] = await db
        .select({ userId: devices.userId, revokedAt: devices.revokedAt, lastSeenAt: devices.lastSeenAt, ttlDays: users.sessionTtlDays })
        .from(devices)
        .innerJoin(users, eq(users.id, devices.userId))
        .where(eq(devices.id, deviceId))
        .limit(1);
      return row ?? null;
    },

    async listActive(userId, now) {
      return db
        .select(sessionColumns)
        .from(devices)
        .where(and(eq(devices.userId, userId), isNull(devices.revokedAt), gt(devices.refreshTokenExpiresAt, now)))
        .orderBy(desc(devices.lastSeenAt));
    },

    async touch(deviceId, at, ipPrefix) {
      await db
        .update(devices)
        .set(ipPrefix ? { lastSeenAt: at, lastIpPrefix: ipPrefix } : { lastSeenAt: at })
        .where(and(eq(devices.id, deviceId), isNull(devices.revokedAt)));
    },

    async revoke(userId, target) {
      const rows = await db
        .update(devices)
        .set(terminatedFields())
        .where(and(eq(devices.userId, userId), isNull(devices.revokedAt), targetCondition(target)))
        .returning({ id: devices.id });
      return rows.map((row) => row.id);
    },

    async revokeInactive(now, scope) {
      const idleTooLong = sql`${devices.lastSeenAt} < ${now.toISOString()}::timestamptz - make_interval(days => (select ${users.sessionTtlDays} from ${users} where ${users.id} = ${devices.userId}))`;
      return db
        .update(devices)
        .set(terminatedFields())
        .where(
          and(
            isNull(devices.revokedAt),
            idleTooLong,
            scope ? eq(devices.userId, scope.userId) : undefined,
            scope ? ne(devices.id, scope.exceptDeviceId) : undefined,
          ),
        )
        .returning({ deviceId: devices.id, userId: devices.userId });
    },

    async getTtlDays(userId) {
      const [row] = await db.select({ days: users.sessionTtlDays }).from(users).where(eq(users.id, userId)).limit(1);
      return row?.days ?? null;
    },

    async setTtlDays(userId, days) {
      await db.update(users).set({ sessionTtlDays: days, updatedAt: new Date() }).where(eq(users.id, userId));
    },
  };
}
