import type { ServerEvent } from '../realtime/protocol.js';

/**
 * What an account's other devices are told about a new sign-in. Descriptive
 * only — the new session's id (so the alert can lead to Settings → Devices),
 * its device label and platform, a coarse location when one is known, and
 * the time. Never a token, key or any other credential.
 */
export interface NewLoginNotice {
  sessionId: string;
  deviceName: string;
  platform: string;
  /** No geolocation source is configured, so this is currently always null. */
  location: string | null;
  at: string;
}

/** The text of the push alert. The OS shows the time the notification arrived next to it. */
export function newLoginPushText(notice: NewLoginNotice): { title: string; body: string } {
  const where = notice.location ? ` near ${notice.location}` : '';
  return {
    title: 'New login detected',
    body: `${notice.deviceName}${where} signed in to your account. Tap to review your devices.`,
  };
}

/**
 * Alerts the account's other devices about a new login: those connected to
 * the realtime socket get an event (the app shows its own notification), the
 * rest a push. The new session itself is told neither.
 */
export async function announceNewLogin({
  userId,
  notice,
  toUser,
  push,
}: {
  userId: string;
  notice: NewLoginNotice;
  toUser(userId: string, event: ServerEvent, options: { exceptDeviceId?: string }): string[];
  /** Pushes to the account's signed-in devices except `excludeDeviceIds`. */
  push(excludeDeviceIds: string[]): Promise<void>;
}): Promise<void> {
  const reached = toUser(userId, { type: 'security.new_login', ...notice }, { exceptDeviceId: notice.sessionId });
  await push([notice.sessionId, ...reached]);
}
