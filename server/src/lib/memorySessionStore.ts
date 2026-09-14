import {
  SESSION_TTL_DEFAULT_DAYS,
  isSessionExpired,
  type EndedSession,
  type RevokeTarget,
  type SessionRecord,
  type SessionStore,
} from './sessions.js';

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A device row as this store keeps it — including the credential columns the real table has, so tests can check they are cleared. */
export interface MemoryDevice extends SessionRecord {
  revokedAt: Date | null;
  refreshTokenHash: string | null;
  refreshTokenExpiresAt: Date | null;
  pushToken: string | null;
}

/**
 * In-memory SessionStore with the same semantics as the Postgres one
 * (sessionStore.ts). Used by tests, which run without a database.
 */
export class MemorySessionStore implements SessionStore {
  readonly devices = new Map<string, MemoryDevice>();
  readonly ttlDays = new Map<string, number>();

  addDevice(device: Partial<MemoryDevice> & { id: string; userId: string }): MemoryDevice {
    const lastSeenAt = device.lastSeenAt ?? new Date();
    const row: MemoryDevice = {
      name: 'Android device',
      model: null,
      platform: 'android',
      osVersion: null,
      appVersion: null,
      lastIpPrefix: null,
      createdAt: lastSeenAt,
      lastSeenAt,
      revokedAt: null,
      refreshTokenHash: 'synthetic-refresh-token-hash',
      refreshTokenExpiresAt: new Date(lastSeenAt.getTime() + REFRESH_TOKEN_TTL_MS),
      pushToken: null,
      ...device,
    };
    this.devices.set(row.id, row);
    if (!this.ttlDays.has(row.userId)) this.ttlDays.set(row.userId, SESSION_TTL_DEFAULT_DAYS);
    return row;
  }

  async findState(deviceId: string) {
    const device = this.devices.get(deviceId);
    if (!device) return null;
    return {
      userId: device.userId,
      revokedAt: device.revokedAt,
      lastSeenAt: device.lastSeenAt,
      ttlDays: this.ttlDays.get(device.userId) ?? SESSION_TTL_DEFAULT_DAYS,
    };
  }

  async listActive(userId: string, now: Date): Promise<SessionRecord[]> {
    return [...this.devices.values()]
      .filter((d) => d.userId === userId && !d.revokedAt && d.refreshTokenExpiresAt !== null && d.refreshTokenExpiresAt > now)
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
      .map((d) => ({
        id: d.id,
        userId: d.userId,
        name: d.name,
        model: d.model,
        platform: d.platform,
        osVersion: d.osVersion,
        appVersion: d.appVersion,
        lastIpPrefix: d.lastIpPrefix,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt,
      }));
  }

  async touch(deviceId: string, at: Date, ipPrefix: string | null): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device || device.revokedAt) return;
    device.lastSeenAt = at;
    if (ipPrefix) device.lastIpPrefix = ipPrefix;
  }

  async revoke(userId: string, target: RevokeTarget): Promise<string[]> {
    const ended: string[] = [];
    for (const device of this.devices.values()) {
      if (device.userId !== userId || device.revokedAt) continue;
      if ('deviceIds' in target && !target.deviceIds.includes(device.id)) continue;
      if ('allExcept' in target && device.id === target.allExcept) continue;
      this.terminate(device);
      ended.push(device.id);
    }
    return ended;
  }

  async revokeInactive(now: Date, scope?: { userId: string; exceptDeviceId: string }): Promise<EndedSession[]> {
    const ended: EndedSession[] = [];
    for (const device of this.devices.values()) {
      if (device.revokedAt) continue;
      if (scope && (device.userId !== scope.userId || device.id === scope.exceptDeviceId)) continue;
      const ttlDays = this.ttlDays.get(device.userId) ?? SESSION_TTL_DEFAULT_DAYS;
      if (!isSessionExpired(device.lastSeenAt, ttlDays, now.getTime())) continue;
      this.terminate(device);
      ended.push({ deviceId: device.id, userId: device.userId });
    }
    return ended;
  }

  async getTtlDays(userId: string): Promise<number | null> {
    return this.ttlDays.get(userId) ?? null;
  }

  async setTtlDays(userId: string, days: number): Promise<void> {
    this.ttlDays.set(userId, days);
  }

  private terminate(device: MemoryDevice): void {
    device.revokedAt = new Date();
    device.refreshTokenHash = null;
    device.refreshTokenExpiresAt = null;
    device.pushToken = null;
  }
}
