import * as SecureStore from 'expo-secure-store';

/**
 * Session material only — see Phase 2 ADR §09. Backed by iOS Keychain /
 * Android Keystore via expo-secure-store, never AsyncStorage. Each value
 * is stored under its own key, not one JSON blob, to stay comfortably
 * under SecureStore's ~2048-byte practical per-value ceiling.
 *
 * Never put here: a password, a plaintext recovery code, or any server
 * secret (pepper, JWT signing key) — none of those belong on the device
 * at all, and the recovery code specifically is shown once in-memory
 * (SignupContext) and never persisted.
 */
const KEYS = {
  accessToken: 'auth_access_token',
  accessTokenExpiresAt: 'auth_access_token_expires_at',
  refreshToken: 'auth_refresh_token',
  refreshTokenExpiresAt: 'auth_refresh_token_expires_at',
  userId: 'auth_user_id',
  username: 'auth_username',
  displayName: 'auth_display_name',
  deviceId: 'auth_device_id',
} as const;

export interface StoredSession {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  userId: string;
  username: string;
  displayName: string;
  deviceId: string;
}

export async function saveSession(session: StoredSession): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(KEYS.accessToken, session.accessToken),
    SecureStore.setItemAsync(KEYS.accessTokenExpiresAt, session.accessTokenExpiresAt),
    SecureStore.setItemAsync(KEYS.refreshToken, session.refreshToken),
    SecureStore.setItemAsync(KEYS.refreshTokenExpiresAt, session.refreshTokenExpiresAt),
    SecureStore.setItemAsync(KEYS.userId, session.userId),
    SecureStore.setItemAsync(KEYS.username, session.username),
    SecureStore.setItemAsync(KEYS.displayName, session.displayName),
    SecureStore.setItemAsync(KEYS.deviceId, session.deviceId),
  ]);
}

export async function loadSession(): Promise<StoredSession | null> {
  const values = await Promise.all(Object.values(KEYS).map((key) => SecureStore.getItemAsync(key)));
  const [accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt, userId, username, displayName, deviceId] =
    values;

  if (!accessToken || !refreshToken || !userId || !username || !deviceId) {
    return null;
  }

  return {
    accessToken,
    accessTokenExpiresAt: accessTokenExpiresAt ?? '',
    refreshToken,
    refreshTokenExpiresAt: refreshTokenExpiresAt ?? '',
    userId,
    username,
    displayName: displayName ?? username,
    deviceId,
  };
}

export async function clearSession(): Promise<void> {
  await Promise.all(Object.values(KEYS).map((key) => SecureStore.deleteItemAsync(key)));
}

const PENDING_SIGN_OUTS_KEY = 'auth_pending_signouts';

/**
 * Sessions this device signed out of whose end the server hasn't confirmed
 * yet (see network/sessionRevocation.ts). Their tokens are kept only until
 * the server has ended them — here, with the other auth material.
 */
export async function loadPendingSignOuts(): Promise<{ accessToken: string; refreshToken: string }[]> {
  try {
    const raw = await SecureStore.getItemAsync(PENDING_SIGN_OUTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is { accessToken: string; refreshToken: string } =>
        typeof item === 'object' && item !== null && typeof item.accessToken === 'string' && typeof item.refreshToken === 'string',
    );
  } catch {
    return [];
  }
}

export async function savePendingSignOuts(items: { accessToken: string; refreshToken: string }[]): Promise<void> {
  if (items.length === 0) await SecureStore.deleteItemAsync(PENDING_SIGN_OUTS_KEY);
  else await SecureStore.setItemAsync(PENDING_SIGN_OUTS_KEY, JSON.stringify(items));
}
