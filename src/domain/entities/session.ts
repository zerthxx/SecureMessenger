export type SessionPlatform = 'ios' | 'android' | 'web';

/**
 * One signed-in session of the account, as Settings → Devices shows it
 * (server: server/src/lib/sessions.ts). Descriptive only — no credential of
 * any kind is part of it.
 */
export interface DeviceSession {
  id: string;
  isCurrent: boolean;
  online: boolean;
  deviceName: string;
  model: string | null;
  platform: SessionPlatform;
  osVersion: string | null;
  appVersion: string | null;
  /** Coarse location, when the server knows one. */
  location: string | null;
  /** The network the session was last active from, partially hidden (e.g. "203.0.113.*"). */
  ipAddress: string | null;
  firstLoginAt: string;
  lastActiveAt: string;
}
