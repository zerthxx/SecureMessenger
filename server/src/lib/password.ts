import { hash, verify, Algorithm } from '@node-rs/argon2';

import { env } from '../config/env.js';

/**
 * Argon2id wrapper for password AND recovery-code hashing, per the
 * Phase 2 ADR (§07, §08) — a recovery code is treated as a second
 * password, hashed identically. This is the only place the pepper is
 * used; nothing else in the codebase should read `ARGON2_PEPPER`.
 *
 * The pepper is passed as Argon2's native `secret` parameter (not
 * string-concatenated into the password) — that's what the parameter
 * exists for, and it keeps the pepper out of the hash's own encoded
 * output entirely.
 *
 * Not wired to any route yet — this phase ships the primitive, not the
 * registration/login flow that will call it.
 */
const pepper = Buffer.from(env.ARGON2_PEPPER, 'utf8');

const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  // OWASP-range parameters, tuned for ~250-500ms on production hardware.
  // Re-tune as hardware improves; changing these does not invalidate
  // existing hashes because Argon2's encoded output embeds its own params.
  memoryCost: 19456, // ~19 MiB
  timeCost: 2,
  parallelism: 1,
  secret: pepper,
} as const;

/** Hash a password or recovery code. Never store or log the input. */
export async function hashSecret(secret: string): Promise<string> {
  return hash(secret, ARGON2_OPTIONS);
}

/** Constant-time verify against a stored Argon2id hash. */
export async function verifySecret(secret: string, encodedHash: string): Promise<boolean> {
  return verify(encodedHash, secret, ARGON2_OPTIONS);
}
