import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';

import type { AuthUser, OwnProfile, ProfileUpdate } from '@/domain/entities';
import { deleteAvatar, uploadAvatar as uploadAvatarBytes } from '@/infrastructure/network/avatarApi';
import { getDeviceInfo, getDeviceMetadata } from '@/infrastructure/network/deviceInfo';
import {
  authApi,
  getApiErrorMessage,
  isUnauthorized,
  setAccessToken,
  setAuthRefreshHandler,
  usersApi,
} from '@/infrastructure/network/trpcClient';
import { primeAvatar } from '@/infrastructure/storage/avatarCache';
import { clearSession, loadSession, saveSession, type StoredSession } from '@/infrastructure/storage/secureAuthStorage';
import { resetSessionsStore } from '@/ui/screens/devices/sessionsStore';
import { clearProfileCache } from '@/ui/screens/profile/profileCache';

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface Session {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  deviceId: string;
}

interface RegisterInput {
  username: string;
  displayName: string;
  password: string;
}

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  /** This device's server-assigned id — needed by E2EE/chat code to tell its own sent messages apart from received ones. Null until authenticated. */
  deviceId: string | null;
  register(input: RegisterInput): Promise<{ recoveryCode: string[] }>;
  login(input: { username: string; password: string }): Promise<void>;
  logout(): Promise<void>;
  logoutAllDevices(): Promise<void>;
  changePassword(input: { currentPassword: string; newPassword: string }): Promise<void>;
  /**
   * Set when the server ended this device's session (terminated from another
   * device, signed out everywhere, or inactivity) and the app signed itself
   * out — so the UI can say why. Cleared on the next sign-in or acknowledgement.
   */
  signedOutReason: 'session_ended' | null;
  acknowledgeSignedOut(): void;
  /** The signed-in user's full profile (bio, birthday, photo). Loaded in the background after sign-in; null until then, or if that load failed. */
  profile: OwnProfile | null;
  /** Re-reads the profile from the server. */
  refreshProfile(): Promise<void>;
  /** Saves the given profile fields on the server and returns what was stored. A changed display name is also written to the stored session so it survives an app restart. */
  updateProfile(input: ProfileUpdate): Promise<OwnProfile>;
  /** Makes an already-resized photo the profile photo. */
  uploadAvatar(photo: { bytes: Uint8Array; mimeType: string }): Promise<void>;
  removeAvatar(): Promise<void>;
  verifyRecoveryCode(input: { username: string; recoveryCode: string }): Promise<{ recoveryToken: string }>;
  resetPassword(input: { recoveryToken: string; newPassword: string }): Promise<{ newRecoveryCode: string[] }>;
  checkUsername(username: string): Promise<{ available: boolean; reason?: string }>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function toStoredSession(user: AuthUser, session: Session): StoredSession {
  return {
    accessToken: session.accessToken,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    refreshToken: session.refreshToken,
    refreshTokenExpiresAt: session.refreshTokenExpiresAt,
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    deviceId: session.deviceId,
  };
}

export function AuthProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [profile, setProfile] = useState<OwnProfile | null>(null);
  const [signedOutReason, setSignedOutReason] = useState<'session_ended' | null>(null);
  // Mirrors state into refs so callbacks below don't need `session`/`user`
  // in their dependency arrays while still reading the latest value.
  const sessionRef = useRef<Session | null>(null);
  const userRef = useRef<AuthUser | null>(null);

  function applySession(nextUser: AuthUser, nextSession: Session) {
    sessionRef.current = nextSession;
    userRef.current = nextUser;
    setAccessToken(nextSession.accessToken);
    setUser(nextUser);
    setDeviceId(nextSession.deviceId);
    setStatus('authenticated');
    setSignedOutReason(null);
  }

  async function clearAuth(reason: 'session_ended' | null = null) {
    sessionRef.current = null;
    userRef.current = null;
    setAccessToken(null);
    setUser(null);
    setDeviceId(null);
    setProfile(null);
    setStatus('unauthenticated');
    setSignedOutReason(reason);
    // Other users' profiles and this account's session list.
    clearProfileCache();
    resetSessionsStore();
    // Session/auth material only. Local conversation/message data is NOT
    // cleared here — it's owner-scoped per account in messageStore (see
    // ChatContext, which points the store at whichever account is
    // currently authenticated) rather than deleted on logout, so a
    // signed-out account's encrypted messages are still there, still
    // decryptable, the next time that same account signs back in.
    await clearSession();
  }

  // Guards against the bootstrap effect below actually running its body
  // twice (React 18 dev-mode double-invokes mount effects, and Fast
  // Refresh can remount a provider) — refresh tokens rotate server-side
  // on every use, so two concurrent `authApi.refresh()` calls would both
  // read the same stored token, both succeed (the server has no
  // optimistic-concurrency guard on that overwrite), and whichever
  // response's `applySession`/`clearAuth` lands last would silently win,
  // sometimes leaving the trpc client's access token cleared while
  // `status` still reads 'authenticated' from the other call.
  const bootstrappedRef = useRef(false);

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    (async () => {
      const stored = await loadSession();
      if (!stored) {
        setStatus('unauthenticated');
        return;
      }
      try {
        const result = await authApi.refresh({ refreshToken: stored.refreshToken, device: getDeviceMetadata() });
        const nextUser: AuthUser = { id: stored.userId, username: stored.username, displayName: stored.displayName };
        const nextSession: Session = { ...result.session, deviceId: stored.deviceId };
        await saveSession(toStoredSession(nextUser, nextSession));
        applySession(nextUser, nextSession);
      } catch (err) {
        await clearAuth(isUnauthorized(err) ? 'session_ended' : null);
      }
    })();
    // Runs once on mount only — this is an app-launch bootstrap, not a
    // reactive effect over changing state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Exchanges the current refresh token for a new access token — the
   * exact same operation the bootstrap effect above runs at app launch,
   * reused here as the handler trpcClient calls the moment any
   * `protectedProcedure` call 401s mid-session (see
   * `withAuthRetry`/`setAuthRefreshHandler` in trpcClient.ts for why
   * that's necessary: the access token's 15-minute TTL routinely
   * outlives a real chat session, and nothing else in the app renews it
   * before then). Reads `sessionRef`/`userRef` rather than `session`/
   * `user` state so trpcClient always calls the *current* handler
   * closure's up-to-date session, not one captured from whenever this
   * effect last ran.
   *
   * Throws when there's no session to refresh or the refresh fails. When
   * the server rejects the refresh token itself (UNAUTHORIZED), that is
   * final — the session was terminated from Settings → Devices, by signing
   * out everywhere, or for inactivity, and nothing can revive it — so the
   * app is signed out too, with `signedOutReason` telling the UI why
   * (SessionEndedNotice). Network failures stay retryable and never sign out.
   */
  const performRefresh = useCallback(async (): Promise<void> => {
    const current = sessionRef.current;
    const currentUser = userRef.current;
    if (!current || !currentUser) {
      throw new Error('Not signed in');
    }
    let result: Awaited<ReturnType<typeof authApi.refresh>>;
    try {
      result = await authApi.refresh({ refreshToken: current.refreshToken, device: getDeviceMetadata() });
    } catch (err) {
      if (isUnauthorized(err) && sessionRef.current === current) {
        await clearAuth('session_ended');
      }
      throw err;
    }
    const nextSession: Session = { ...result.session, deviceId: current.deviceId };
    await saveSession(toStoredSession(currentUser, nextSession));
    applySession(currentUser, nextSession);
  }, []);

  useEffect(() => {
    setAuthRefreshHandler(performRefresh);
    return () => setAuthRefreshHandler(null);
  }, [performRefresh]);

  /**
   * Stores a profile fresh from the server. The display name shown after an
   * app restart comes from the stored session (see the bootstrap effect), so
   * a changed name is saved there too. Ignored if the account signed out
   * while the request was in flight.
   */
  async function applyProfile(next: OwnProfile) {
    const currentUser = userRef.current;
    if (!currentUser || currentUser.id !== next.id) return;
    setProfile(next);
    if (currentUser.displayName === next.displayName) return;
    const nextUser: AuthUser = { ...currentUser, displayName: next.displayName };
    userRef.current = nextUser;
    setUser(nextUser);
    const currentSession = sessionRef.current;
    if (currentSession) {
      await saveSession(toStoredSession(nextUser, currentSession));
    }
  }

  const loadProfile = useCallback(async (): Promise<void> => {
    const { profile: loaded } = await usersApi.me();
    await applyProfile(loaded);
    // applyProfile only reads refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once per signed-in account — not polled. Until it loads (or if it fails),
  // screens fall back to the name from the stored session.
  const signedInUserId = status === 'authenticated' ? (user?.id ?? null) : null;
  useEffect(() => {
    if (!signedInUserId) return;
    loadProfile().catch(() => {});
  }, [signedInUserId, loadProfile]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      deviceId,
      profile,
      signedOutReason,

      acknowledgeSignedOut() {
        setSignedOutReason(null);
      },

      async register({ username, displayName, password }) {
        const result = await authApi.register({
          username,
          displayName,
          password,
          device: getDeviceInfo(),
        });
        const nextSession: Session = { ...result.session, deviceId: result.device.id };
        await saveSession(toStoredSession(result.user, nextSession));
        applySession(result.user, nextSession);
        return { recoveryCode: result.recoveryCode };
      },

      async login({ username, password }) {
        const result = await authApi.login({ username, password, device: getDeviceInfo() });
        const nextSession: Session = { ...result.session, deviceId: result.device.id };
        await saveSession(toStoredSession(result.user, nextSession));
        applySession(result.user, nextSession);
      },

      async logout() {
        try {
          await authApi.logout();
        } finally {
          await clearAuth();
        }
      },

      async logoutAllDevices() {
        try {
          await authApi.logoutAllDevices();
        } finally {
          await clearAuth();
        }
      },

      async changePassword({ currentPassword, newPassword }) {
        await authApi.changePassword({ currentPassword, newPassword });
      },

      async refreshProfile() {
        await loadProfile();
      },

      async updateProfile(input) {
        const { user: saved } = await usersApi.updateProfile(input);
        await applyProfile(saved);
        return saved;
      },

      async uploadAvatar(photo) {
        const { avatarId } = await uploadAvatarBytes(photo);
        // The uploader already has the bytes — never download them back.
        primeAvatar(avatarId, photo.bytes);
        if (profile) {
          setProfile((current) => (current ? { ...current, avatarId } : current));
        } else {
          await loadProfile().catch(() => {});
        }
      },

      async removeAvatar() {
        await deleteAvatar();
        setProfile((current) => (current ? { ...current, avatarId: null } : current));
      },

      async verifyRecoveryCode({ username, recoveryCode }) {
        return authApi.recovery.verifyCode({ username, recoveryCode });
      },

      async resetPassword({ recoveryToken, newPassword }) {
        return authApi.recovery.resetPassword({ recoveryToken, newPassword });
      },

      async checkUsername(username) {
        return authApi.checkUsername({ username });
      },
    }),
    [status, user, deviceId, profile, signedOutReason, loadProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}

export { getApiErrorMessage };
