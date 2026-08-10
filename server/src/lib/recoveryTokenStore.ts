import { RECOVERY_TOKEN_TTL_SECONDS } from './tokens.js';

/**
 * In-memory single-use tracking for recovery-token jtis — the same
 * documented stopgap as rateLimit.ts: this only enforces single-use
 * within *this* process, which is fine for the current single-instance
 * deployment and becomes Redis's job (alongside rate limiting) once the
 * API is horizontally scaled.
 *
 * Without this, a JWT's signature+expiry check alone doesn't make it
 * single-use — the same recovery token could reset the password
 * repeatedly inside its 5-minute window.
 */
const usedJtis = new Map<string, number>(); // jti -> expiresAtMs

const MAX_TRACKED_JTIS = 50_000;

function sweepExpired(now: number): void {
  for (const [jti, expiresAt] of usedJtis) {
    if (expiresAt <= now) {
      usedJtis.delete(jti);
    }
  }
}

/** Returns true and marks the jti spent if it hadn't been used yet; false if it was already used. */
export function spendRecoveryTokenJti(jti: string): boolean {
  const now = Date.now();
  if (usedJtis.size >= MAX_TRACKED_JTIS) {
    sweepExpired(now);
  }

  if (usedJtis.has(jti)) {
    return false;
  }

  usedJtis.set(jti, now + RECOVERY_TOKEN_TTL_SECONDS * 1000);
  return true;
}
