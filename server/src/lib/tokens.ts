import { randomBytes, createHash } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';

import { env } from '../config/env.js';

const secretKey = new TextEncoder().encode(env.ACCESS_TOKEN_SECRET);

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes, per Phase 2 ADR §05
export const REFRESH_TOKEN_TTL_DAYS = 30;
export const RECOVERY_TOKEN_TTL_SECONDS = 5 * 60;

interface AccessTokenPayload {
  sub: string; // userId
  deviceId: string;
  purpose: 'access';
}

interface RecoveryTokenPayload {
  sub: string; // userId
  purpose: 'recovery';
  jti: string;
}

/**
 * Short-lived, self-contained access token. Verified by signature + expiry
 * only (no DB hit) — that's the whole point of the hybrid session model in
 * the Phase 2 ADR (§05): a stolen token is useless after ~15 minutes even
 * though nothing looked it up.
 */
export async function signAccessToken(userId: string, deviceId: string): Promise<string> {
  return new SignJWT({ deviceId, purpose: 'access' } satisfies Omit<AccessTokenPayload, 'sub'>)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secretKey);
}

export async function verifyAccessToken(token: string): Promise<{ userId: string; deviceId: string } | null> {
  try {
    const { payload } = await jwtVerify<AccessTokenPayload>(token, secretKey);
    if (payload.purpose !== 'access' || typeof payload.deviceId !== 'string' || !payload.sub) {
      return null;
    }
    return { userId: payload.sub, deviceId: payload.deviceId };
  } catch {
    return null;
  }
}

/**
 * Purpose-scoped so a recovery token can never be replayed as an access
 * token. Also carries a `jti` — a JWT's signature+expiry alone doesn't
 * make it single-use, and `resetPassword` spends this jti (see
 * recoveryTokenStore.ts) so the same token can't reset the password
 * twice inside its 5-minute window.
 */
export async function signRecoveryToken(userId: string): Promise<{ token: string; jti: string }> {
  const jti = randomBytes(16).toString('hex');
  const token = await new SignJWT({ purpose: 'recovery', jti } satisfies Omit<RecoveryTokenPayload, 'sub'>)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${RECOVERY_TOKEN_TTL_SECONDS}s`)
    .sign(secretKey);
  return { token, jti };
}

export async function verifyRecoveryToken(token: string): Promise<{ userId: string; jti: string } | null> {
  try {
    const { payload } = await jwtVerify<RecoveryTokenPayload>(token, secretKey);
    if (payload.purpose !== 'recovery' || !payload.sub || typeof payload.jti !== 'string') {
      return null;
    }
    return { userId: payload.sub, jti: payload.jti };
  } catch {
    return null;
  }
}

/** Opaque, high-entropy — this is what the client stores, never the raw device row value. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Refresh tokens are already 256 bits of random entropy, unlike a
 * human-chosen password — a fast hash (not Argon2id) is the correct,
 * standard treatment here, the same way most systems hash API keys.
 */
export function hashRefreshToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export function refreshTokenExpiryDate(): Date {
  return new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}
