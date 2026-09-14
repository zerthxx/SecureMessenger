/** Display formatting for Settings → Devices. Pure; uses the device locale's own date and time conventions. */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const AUTO_TERMINATE_MIN_DAYS = 7;
export const AUTO_TERMINATE_MAX_DAYS = 730;

export const AUTO_TERMINATE_PRESETS: readonly { days: number; label: string }[] = [
  { days: 7, label: '1 week' },
  { days: 30, label: '1 month' },
  { days: 90, label: '3 months' },
  { days: 180, label: '6 months' },
  { days: 365, label: '1 year' },
];

export function platformLabel(platform: string): string {
  switch (platform) {
    case 'android':
      return 'Android';
    case 'ios':
      return 'iOS';
    case 'web':
      return 'Web';
    default:
      return platform;
  }
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "just now", "5 min ago", "today at 2:05 PM", "yesterday at 9:12 AM", "Monday", or a date for anything older than a week. */
export function formatLastActive(iso: string, now: number = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return 'unknown';
  const elapsed = now - time;
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;

  const date = new Date(time);
  const today = new Date(now);
  const clock = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (isSameDay(date, today)) return `today at ${clock}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (isSameDay(date, yesterday)) return `yesterday at ${clock}`;
  if (elapsed < 7 * DAY) return date.toLocaleDateString(undefined, { weekday: 'long' });
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** A full date and time, e.g. "September 14, 2026 at 2:05 PM". */
export function formatDateTime(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return 'Unknown';
  return new Date(time).toLocaleString(undefined, { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function formatAutoTerminate(days: number): string {
  return AUTO_TERMINATE_PRESETS.find((preset) => preset.days === days)?.label ?? `${days} days`;
}

/** Validates a custom inactivity period typed by the user. */
export function parseCustomDays(text: string): { days: number } | { error: string } {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { error: 'Enter a whole number of days.' };
  const days = Number(trimmed);
  if (days < AUTO_TERMINATE_MIN_DAYS) return { error: `Choose at least ${AUTO_TERMINATE_MIN_DAYS} days.` };
  if (days > AUTO_TERMINATE_MAX_DAYS) return { error: `Choose at most ${AUTO_TERMINATE_MAX_DAYS} days (2 years).` };
  return { days };
}
