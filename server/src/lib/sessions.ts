import type { NewLoginNotice } from './newLogin.js';

/**
 * Signed-in sessions — what Settings → Devices shows. A session IS a
 * `devices` row: one per login, holding the hashed refresh token (auth.ts).
 * This module owns a session's life after login: listing, terminating one or
 * all others, automatic termination after inactivity, and the check that
 * makes termination take effect immediately.
 *
 * Why that check exists: access tokens are self-contained JWTs verified by
 * signature alone (lib/tokens.ts), so by themselves a terminated device would
 * keep API access until its token expired (up to 15 minutes). Every
 * authenticated entry point — tRPC's protectedProcedure, the media/avatar
 * routes and the realtime socket — therefore also asks `isActive`.
 * Terminations made by this process are known instantly; otherwise the
 * database is consulted at most once per VERIFIED_CACHE_MS per device.
 */

export const SESSION_TTL_DEFAULT_DAYS = 180;
export const SESSION_TTL_MIN_DAYS = 7;
export const SESSION_TTL_MAX_DAYS = 730;
export const SESSION_TERMINATED_MESSAGE = 'This session has been terminated. Please log in again.';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a positive "still active" answer is trusted before the database is asked again. */
export const VERIFIED_CACHE_MS = 30 * 1000;
/** Activity (last seen, network) is written at most this often per device. */
export const TOUCH_INTERVAL_MS = 60 * 1000;
const MAX_TRACKED_DEVICES = 50_000;

export type SessionPlatform = 'ios' | 'android' | 'web';

/** A session as the store returns it: descriptive columns only — never the refresh-token hash, push token or keys. */
export interface SessionRecord {
  id: string;
  userId: string;
  name: string;
  model: string | null;
  platform: SessionPlatform;
  osVersion: string | null;
  appVersion: string | null;
  lastIpPrefix: string | null;
  createdAt: Date;
  lastSeenAt: Date;
}

export interface SessionState {
  userId: string;
  revokedAt: Date | null;
  lastSeenAt: Date;
  /** The account's "automatically terminate old sessions" setting. */
  ttlDays: number;
}

export type RevokeTarget = { deviceIds: readonly string[] } | { allExcept: string } | { all: true };

export interface EndedSession {
  deviceId: string;
  userId: string;
}

/** Persistence for sessions — Postgres in production (sessionStore.ts), in memory in tests (memorySessionStore.ts). */
export interface SessionStore {
  findState(deviceId: string): Promise<SessionState | null>;
  /** The account's sessions that are neither terminated nor past their refresh-token expiry. */
  listActive(userId: string, now: Date): Promise<SessionRecord[]>;
  touch(deviceId: string, at: Date, ipPrefix: string | null): Promise<void>;
  /**
   * Terminates live sessions matching `target` — of `userId` ONLY, which is
   * what makes it impossible to end another account's session — and clears
   * their refresh token and push token. Returns the ids actually ended.
   */
  revoke(userId: string, target: RevokeTarget): Promise<string[]>;
  /** Terminates sessions idle longer than their account's setting: every account, or one account sparing one device. */
  revokeInactive(now: Date, scope?: { userId: string; exceptDeviceId: string }): Promise<EndedSession[]>;
  getTtlDays(userId: string): Promise<number | null>;
  setTtlDays(userId: string, days: number): Promise<void>;
}

/** A session as the app shows it. Fields are copied one by one in `toSessionSummary`; nothing secret is ever part of it. */
export interface SessionSummary {
  id: string;
  isCurrent: boolean;
  online: boolean;
  deviceName: string;
  model: string | null;
  platform: SessionPlatform;
  osVersion: string | null;
  appVersion: string | null;
  /** Coarse location. No geolocation source is configured, so this is currently always null ("Unavailable"). */
  location: string | null;
  /** The truncated network the session was last active from (e.g. "203.0.113.*"), never a full address. */
  ipAddress: string | null;
  firstLoginAt: string;
  lastActiveAt: string;
}

/**
 * Reduces an IP address to its network before it is stored: IPv4 to /24
 * ("203.0.113.*"), IPv6 to /48 ("2001:db8:85a3:*"). Returns null for anything
 * that isn't a valid address.
 */
export function truncateIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  let value = ip.trim();
  if (value.toLowerCase().startsWith('::ffff:') && value.includes('.')) value = value.slice('::ffff:'.length);

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    return `${octets.slice(0, 3).join('.')}.*`;
  }

  const groups = expandIpv6(value);
  return groups ? `${groups.slice(0, 3).join(':')}:*` : null;
}

function expandIpv6(value: string): string[] | null {
  const address = value.split('%')[0] ?? '';
  if (!address.includes(':') || !/^[0-9a-fA-F:]+$/.test(address)) return null;
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  }
  if (groups.some((group) => group.length === 0 || group.length > 4)) return null;
  return groups.map((group) => group.toLowerCase().replace(/^0+(?=.)/, ''));
}

export function isSessionExpired(lastSeenAt: Date, ttlDays: number, now: number): boolean {
  return now - lastSeenAt.getTime() > ttlDays * DAY_MS;
}

export function isValidTtlDays(days: number): boolean {
  return Number.isInteger(days) && days >= SESSION_TTL_MIN_DAYS && days <= SESSION_TTL_MAX_DAYS;
}

export function toSessionSummary(record: SessionRecord, context: { currentDeviceId: string; online: boolean; now: number }): SessionSummary {
  const isCurrent = record.id === context.currentDeviceId;
  return {
    id: record.id,
    isCurrent,
    online: isCurrent || context.online,
    deviceName: record.model ?? record.name,
    model: record.model,
    platform: record.platform,
    osVersion: record.osVersion,
    appVersion: record.appVersion,
    location: null,
    ipAddress: record.lastIpPrefix,
    firstLoginAt: record.createdAt.toISOString(),
    // The current device is, by definition, active right now.
    lastActiveAt: (isCurrent ? new Date(context.now) : record.lastSeenAt).toISOString(),
  };
}

export interface SessionHooks {
  /** Whether the device has a live realtime connection. */
  isOnline(deviceId: string): boolean;
  /** Tears down what ended sessions still have open in this process (realtime sockets, calls). */
  onRevoked(ended: EndedSession[]): void;
  /** Alerts the account's other sessions about a new login. */
  onNewLogin(userId: string, notice: NewLoginNotice): void;
}

interface WarnLog {
  warn(obj: object, msg: string): void;
}

export class SessionManager {
  private readonly verifiedAt = new Map<string, { userId: string; at: number }>();
  private readonly revoked = new Set<string>();
  private readonly touchedAt = new Map<string, number>();

  constructor(
    private readonly store: SessionStore,
    private readonly hooks: SessionHooks,
    private readonly log?: WarnLog,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Whether the session behind an (already signature-verified) access token
   * is still live: not terminated, belonging to that account, and not idle
   * past the account's automatic-termination setting — which it is ended for
   * here, on the spot.
   */
  async isActive(userId: string, deviceId: string): Promise<boolean> {
    if (this.revoked.has(deviceId)) return false;
    const now = this.now();
    const verified = this.verifiedAt.get(deviceId);
    if (verified && verified.userId === userId && now - verified.at < VERIFIED_CACHE_MS) return true;

    const state = await this.store.findState(deviceId);
    if (!state || state.userId !== userId) return false;
    if (state.revokedAt) {
      this.remember(deviceId);
      return false;
    }
    if (isSessionExpired(state.lastSeenAt, state.ttlDays, now)) {
      await this.revoke(userId, { deviceIds: [deviceId] });
      return false;
    }
    if (this.verifiedAt.size >= MAX_TRACKED_DEVICES) this.verifiedAt.clear();
    this.verifiedAt.set(deviceId, { userId, at: now });
    return true;
  }

  /** Synchronous: whether this process already knows the session is terminated (used per realtime message). */
  isKnownRevoked(deviceId: string): boolean {
    return this.revoked.has(deviceId);
  }

  /** Records that the session was just used, from `ip`. Throttled; never throws and is never awaited on the request path. */
  touch(deviceId: string, ip: string | null | undefined): void {
    const now = this.now();
    const last = this.touchedAt.get(deviceId);
    if (last !== undefined && now - last < TOUCH_INTERVAL_MS) return;
    if (this.touchedAt.size >= MAX_TRACKED_DEVICES) this.touchedAt.clear();
    this.touchedAt.set(deviceId, now);
    this.store.touch(deviceId, new Date(now), truncateIp(ip)).catch((err: unknown) => {
      this.log?.warn({ err, deviceId }, 'failed to record session activity');
    });
  }

  /** The account's live sessions: this device first, then online ones, then most recently active. */
  async list(userId: string, currentDeviceId: string): Promise<SessionSummary[]> {
    const now = this.now();
    const records = await this.store.listActive(userId, new Date(now));
    return records
      .filter((record) => record.userId === userId)
      .map((record) => toSessionSummary(record, { currentDeviceId, online: this.hooks.isOnline(record.id), now }))
      .sort(
        (a, b) =>
          Number(b.isCurrent) - Number(a.isCurrent) ||
          Number(b.online) - Number(a.online) ||
          b.lastActiveAt.localeCompare(a.lastActiveAt),
      );
  }

  /** One of the account's own live sessions, or null — including for any session of another account. */
  async get(userId: string, currentDeviceId: string, sessionId: string): Promise<SessionSummary | null> {
    const sessions = await this.list(userId, currentDeviceId);
    return sessions.find((session) => session.id === sessionId) ?? null;
  }

  /** Ends one of the account's other sessions. The current one is ended by signing out, never from the list. */
  async terminate(userId: string, currentDeviceId: string, sessionId: string): Promise<'terminated' | 'current' | 'not_found'> {
    if (sessionId === currentDeviceId) return 'current';
    const ended = await this.revoke(userId, { deviceIds: [sessionId] });
    return ended.length > 0 ? 'terminated' : 'not_found';
  }

  /** Ends every session of the account except the current one. */
  async terminateAllOthers(userId: string, currentDeviceId: string): Promise<number> {
    return (await this.revoke(userId, { allExcept: currentDeviceId })).length;
  }

  async getAutoTerminateDays(userId: string): Promise<number> {
    return (await this.store.getTtlDays(userId)) ?? SESSION_TTL_DEFAULT_DAYS;
  }

  /**
   * Saves the account's inactivity limit and applies it at once to the other
   * sessions. The current device is always spared: it is in use right now.
   * Returns how many sessions were ended.
   */
  async setAutoTerminateDays(userId: string, currentDeviceId: string, days: number): Promise<number> {
    if (!isValidTtlDays(days)) {
      throw new RangeError(`Automatic termination must be between ${SESSION_TTL_MIN_DAYS} and ${SESSION_TTL_MAX_DAYS} days.`);
    }
    await this.store.setTtlDays(userId, days);
    const ended = await this.store.revokeInactive(new Date(this.now()), { userId, exceptDeviceId: currentDeviceId });
    this.ended(ended);
    return ended.length;
  }

  /**
   * Ends sessions of one account — the single path every termination takes:
   * the Devices screen, sign-out, sign-out everywhere, password change and
   * account recovery. Returns the ids ended.
   */
  async revoke(userId: string, target: RevokeTarget): Promise<string[]> {
    const ids = await this.store.revoke(userId, target);
    this.ended(ids.map((deviceId) => ({ deviceId, userId })));
    return ids;
  }

  /** Enforces every account's automatic-termination setting; run periodically (index.ts). */
  async sweepInactive(): Promise<number> {
    const ended = await this.store.revokeInactive(new Date(this.now()));
    this.ended(ended);
    return ended.length;
  }

  announceNewLogin(userId: string, notice: NewLoginNotice): void {
    try {
      this.hooks.onNewLogin(userId, notice);
    } catch (err) {
      this.log?.warn({ err, userId }, 'failed to announce new login');
    }
  }

  private ended(sessions: EndedSession[]): void {
    if (sessions.length === 0) return;
    for (const { deviceId } of sessions) this.remember(deviceId);
    try {
      this.hooks.onRevoked(sessions);
    } catch (err) {
      this.log?.warn({ err }, 'failed to tear down terminated sessions');
    }
  }

  private remember(deviceId: string): void {
    // A terminated session never comes back, so forgetting old entries only
    // costs a database lookup — never lets a session back in.
    if (this.revoked.size >= MAX_TRACKED_DEVICES) this.revoked.clear();
    this.revoked.add(deviceId);
    this.verifiedAt.delete(deviceId);
    this.touchedAt.delete(deviceId);
  }
}
