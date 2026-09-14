/**
 * Birthdays are calendar dates with no time or timezone, exchanged with the
 * server as ISO `YYYY-MM-DD` strings. Every conversion here goes through
 * local calendar components (never `toISOString`, which is UTC and can shift
 * the day), and display uses the device locale's own date format.
 */

export interface BirthdayParts {
  month: number;
  day: number;
  /** Null when the year isn't known or isn't shown. */
  year: number | null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Earliest birthday the server accepts. */
export const BIRTHDAY_MIN_DATE = new Date(1900, 0, 1);

export function parseIsoDate(value: string): { year: number; month: number; day: number } | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** The date picker's chosen day as `YYYY-MM-DD`, read from local calendar fields. */
export function toIsoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** A local Date at noon on that day — noon keeps DST transitions from moving it to a neighbouring day. */
export function isoDateToLocalDate(value: string): Date | null {
  const parts = parseIsoDate(value);
  return parts ? new Date(parts.year, parts.month - 1, parts.day, 12) : null;
}

/** "April 12, 1990" (or the locale's equivalent), or "April 12" when the year isn't shown. */
export function formatBirthday(birthday: BirthdayParts, locale?: string): string {
  // 2000 is a leap year, so a Feb 29 birthday still formats when the year is hidden.
  const date = new Date(birthday.year ?? 2000, birthday.month - 1, birthday.day, 12);
  return date.toLocaleDateString(
    locale,
    birthday.year === null ? { month: 'long', day: 'numeric' } : { year: 'numeric', month: 'long', day: 'numeric' },
  );
}

export function formatIsoBirthday(value: string, locale?: string): string {
  const parts = parseIsoDate(value);
  return parts ? formatBirthday(parts, locale) : value;
}
