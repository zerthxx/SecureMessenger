/**
 * How long to wait before the next background poll of the server (the open
 * chat's `fetchMessages`, the chat list's `listConversations`).
 *
 * With the realtime socket up, polling is only a safety net: the server's
 * "conversation updated" hint is what delivers promptly, so the cadence is
 * slow and jittered (jitter spreads a fleet that reconnected together after
 * a deploy, instead of having it poll in lockstep).
 *
 * With the socket DOWN, polling is the only delivery path, so it starts
 * fast — but a fixed fast cadence is what turns a realtime outage into a
 * database outage: 10,000 phones polling every 3 s is ~3,000 requests/s
 * (see docs/ENGINEERING_CHECKLIST.md, scale readiness, risk S1). So each
 * quiet poll doubles the wait, up to the online cadence: 3 → 6 → 12 → 24 →
 * 30 s. Anything that suggests the person is active — the app coming to the
 * foreground, a message sent, a poll that found something — resets the
 * series, so an active chat stays responsive and only idle phones back off.
 *
 * Pure (no timers, no React Native), so it is unit tested; the screens own
 * the timer and the counter.
 */

export interface PollScheduleInput {
  /** The realtime socket is connected: hints deliver, polling is a safety net. */
  realtimeOnline: boolean;
  /** Polls in a row, while the socket was down, that found nothing new. */
  quietPolls: number;
  /** The first offline wait (ms). */
  baseMs: number;
  /** The wait while online, and the cap while offline (ms). */
  onlineMs: number;
  /** Uniform random in [0, 1); injectable for tests. */
  random?: () => number;
}

/** ±25 % around `ms`, so many clients on the same schedule drift apart. */
export function jitter(ms: number, random: () => number = Math.random): number {
  return Math.round(ms * (0.75 + random() * 0.5));
}

export function nextPollDelayMs({ realtimeOnline, quietPolls, baseMs, onlineMs, random = Math.random }: PollScheduleInput): number {
  if (realtimeOnline) return jitter(onlineMs, random);
  const exponent = Math.max(0, Math.min(30, Math.floor(quietPolls)));
  const backedOff = Math.min(onlineMs, baseMs * 2 ** exponent);
  return jitter(backedOff, random);
}
