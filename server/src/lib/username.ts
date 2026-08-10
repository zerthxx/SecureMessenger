const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;

/**
 * System/reserved handles no account may take. Extend this list rather
 * than relying on the client — the server is the sole authority now.
 */
const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'root', 'support', 'help', 'moderator', 'mod',
  'system', 'api', 'null', 'undefined', 'test', 'security', 'staff',
  'official', 'securemessenger', 'secure_messenger',
]);

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export type UsernameValidationResult =
  | { valid: true }
  | { valid: false; reason: 'invalid' | 'reserved' };

/** Format + reserved-list check only — does NOT check the database for uniqueness. */
export function validateUsernameFormat(rawUsername: string): UsernameValidationResult {
  const normalized = normalizeUsername(rawUsername);
  if (!USERNAME_PATTERN.test(normalized)) {
    return { valid: false, reason: 'invalid' };
  }
  if (RESERVED_USERNAMES.has(normalized)) {
    return { valid: false, reason: 'reserved' };
  }
  return { valid: true };
}
