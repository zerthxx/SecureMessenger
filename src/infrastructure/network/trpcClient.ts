import { createTRPCUntypedClient, httpBatchLink, TRPCClientError } from '@trpc/client';

// NOTE ON THIS FILE'S SHAPE — read before "simplifying" it back to
// createTRPCClient<AppRouter>(): that was the first approach tried here,
// and it type-checks in isolation but collapses `trpcClient.auth.*` to
// `never` once the router type crosses this package boundary (a real
// bug in tRPC v11's DecoratedProcedureRecord mapped-type inference
// against a relative cross-package `import type`, confirmed by
// bisecting with throwaway probe files — not a config mistake here).
// createTRPCUntypedClient gives the same wire client without the broken
// proxy typing; the `AppRouter` import below is now used only to keep
// each wrapper's input/output shape pinned to the real Zod schemas via
// `inferProcedureInput`/`inferOutput`, so a server-side schema change
// still shows up here as a type error instead of silently drifting.
import type { AppRouter, RouterInputs, RouterOutputs } from '../../../server/src/trpc/router';

/**
 * 10.0.2.2 is the Android emulator's alias for the host machine's
 * localhost — plain "localhost" would resolve to the emulator itself.
 * Override with EXPO_PUBLIC_API_URL (Expo inlines EXPO_PUBLIC_* at build
 * time, no extra config needed) to point at a real deployment.
 *
 * The emulator-only fallback is gated behind `__DEV__` rather than a
 * plain `?? 'http://10.0.2.2:4000'` so a release build that's ever cut
 * without EXPO_PUBLIC_API_URL set fails loudly at launch instead of
 * silently shipping pointed at a dev-only address — `if (__DEV__)` is
 * the standard RN/Metro dead-code-elimination guard (like React's own
 * dev-only warnings), so this branch and its string literal are
 * provably stripped from a release bundle, unlike a generic `??`
 * fallback a minifier isn't guaranteed to fold away.
 */
function resolveApiBaseUrl(): string {
  if (process.env.EXPO_PUBLIC_API_URL) {
    const url = process.env.EXPO_PUBLIC_API_URL;
    // Audit fix: the APK download URL was already checked for `https:`
    // (see isApkUrlTrusted in the update module) but the API base URL
    // itself had no equivalent check — a release accidentally built with
    // an http:// EXPO_PUBLIC_API_URL would silently send every tRPC call
    // (including auth tokens) in plaintext. __DEV__-gated so local/LAN
    // development against a plain-http dev server keeps working.
    if (!__DEV__ && !url.startsWith('https://')) {
      throw new Error('EXPO_PUBLIC_API_URL must use https:// in a release build.');
    }
    return url;
  }
  if (__DEV__) return 'http://10.0.2.2:4000';
  throw new Error('EXPO_PUBLIC_API_URL must be set for a release build.');
}

// Exported so other trusted-host consumers (e.g. the update-manifest
// fetch in src/infrastructure/update) derive the same production host
// this client itself talks to, rather than re-reading the env var and
// risking a second, possibly-inconsistent source of truth for "which
// server is trusted."
export const API_BASE_URL = resolveApiBaseUrl();

let currentAccessToken: string | null = null;

/** Called by AuthContext whenever the session changes — login, refresh, logout. */
export function setAccessToken(token: string | null): void {
  currentAccessToken = token;
}

/**
 * Exposes the current access token to other trusted HTTP clients in this
 * app (currently just voiceMediaApi.ts's binary upload/download, which
 * can't go through httpBatchLink) so there is exactly one source of
 * truth for "what token is live right now" — never a second, independently
 * tracked copy.
 */
export function getAccessTokenForRequest(): string | null {
  return currentAccessToken;
}

const untypedClient = createTRPCUntypedClient<AppRouter>({
  links: [
    httpBatchLink({
      url: `${API_BASE_URL}/trpc`,
      headers: () => (currentAccessToken ? { authorization: `Bearer ${currentAccessToken}` } : {}),
    }),
  ],
});

type Inputs = RouterInputs;
type Outputs = RouterOutputs;

/**
 * The access token is short-lived (15 minutes — see the server's
 * ACCESS_TOKEN_TTL_SECONDS) and nothing here refreshes it proactively.
 * Before this wrapper existed, every wrapper function below called
 * `untypedClient` directly: the first authenticated call made after the
 * token expired got a 401 UNAUTHORIZED from the server's
 * `protectedProcedure` middleware, and — because nothing caught that
 * specific error and retried — every later call in the same app session
 * kept 401ing the same way forever (confirmed via a live repro: a
 * message send that failed this way, followed by a poll cycle whose
 * fetchMessages call 401ed too). A `sendMessage` failing this way looks
 * identical to a real network failure in the UI ("Failed to send"), but
 * it is neither a lost response nor a dropped connection — the server
 * never saw a valid request to act on.
 *
 * AuthContext registers `authRefreshHandler` with the same
 * refresh-token exchange it already runs at app bootstrap, so a token
 * that expires *mid-session* is refreshed the same way one that's
 * already expired at launch is. Concurrent 401s (e.g. several messages
 * in flight at once) share one in-flight refresh via `refreshInFlight`
 * — never more than one refresh-token exchange at a time, for the same
 * "refresh tokens rotate on every use" reason AuthContext's own
 * bootstrap guard exists (see its doc comment).
 */
type AuthRefreshHandler = () => Promise<void>;
let authRefreshHandler: AuthRefreshHandler | null = null;
let refreshInFlight: Promise<void> | null = null;

/** Called by AuthContext once it mounts (and cleared on unmount/logout). */
export function setAuthRefreshHandler(handler: AuthRefreshHandler | null): void {
  authRefreshHandler = handler;
}

function isUnauthorized(err: unknown): boolean {
  return err instanceof TRPCClientError && (err.data as { code?: string } | null)?.code === 'UNAUTHORIZED';
}

/**
 * Runs `call` once; on a 401, refreshes the access token (deduped
 * against any other 401 already refreshing) and retries `call` exactly
 * once more. A retry that still 401s (e.g. the refresh token itself is
 * no longer valid — a genuinely signed-out session) propagates that
 * second error rather than looping.
 */
async function withAuthRetry<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!isUnauthorized(err) || !authRefreshHandler) throw err;
    if (!refreshInFlight) {
      refreshInFlight = authRefreshHandler().finally(() => {
        refreshInFlight = null;
      });
    }
    await refreshInFlight;
    return call();
  }
}

/**
 * Same refresh-and-dedupe mechanism as `withAuthRetry` above, exposed for
 * callers outside the tRPC client (voiceMediaApi.ts's plain `fetch`
 * calls, which get a raw HTTP 401 rather than a `TRPCClientError` and so
 * can't reuse `withAuthRetry` directly). Shares the same
 * `authRefreshHandler`/`refreshInFlight` state, so a refresh triggered
 * from here and one triggered from a concurrent tRPC 401 are still
 * deduped to a single in-flight exchange. Returns `false` (never throws)
 * on a failed/unavailable refresh — the caller's own request will then
 * fail with whatever 401 response it already got.
 */
export async function refreshAccessTokenOnce(): Promise<boolean> {
  if (!authRefreshHandler) return false;
  if (!refreshInFlight) {
    refreshInFlight = authRefreshHandler().finally(() => {
      refreshInFlight = null;
    });
  }
  try {
    await refreshInFlight;
    return true;
  } catch {
    return false;
  }
}

/**
 * Hand-written, explicitly-typed wrapper around the untyped client — one
 * function per auth procedure, each pinned to the server's real
 * input/output types. This is the boundary described above: everything
 * past this point in the app calls plain typed functions and never
 * touches the untyped client or raw string paths directly.
 */
export const authApi = {
  checkUsername: (input: Inputs['auth']['checkUsername']) =>
    untypedClient.query('auth.checkUsername', input) as Promise<Outputs['auth']['checkUsername']>,

  register: (input: Inputs['auth']['register']) =>
    untypedClient.mutation('auth.register', input) as Promise<Outputs['auth']['register']>,

  login: (input: Inputs['auth']['login']) =>
    untypedClient.mutation('auth.login', input) as Promise<Outputs['auth']['login']>,

  refresh: (input: Inputs['auth']['refresh']) =>
    untypedClient.mutation('auth.refresh', input) as Promise<Outputs['auth']['refresh']>,

  logout: () => withAuthRetry(() => untypedClient.mutation('auth.logout')) as Promise<Outputs['auth']['logout']>,

  logoutAllDevices: () =>
    withAuthRetry(() => untypedClient.mutation('auth.logoutAllDevices')) as Promise<Outputs['auth']['logoutAllDevices']>,

  changePassword: (input: Inputs['auth']['changePassword']) =>
    withAuthRetry(() => untypedClient.mutation('auth.changePassword', input)) as Promise<Outputs['auth']['changePassword']>,

  recovery: {
    verifyCode: (input: Inputs['auth']['recovery']['verifyCode']) =>
      untypedClient.mutation('auth.recovery.verifyCode', input) as Promise<Outputs['auth']['recovery']['verifyCode']>,

    resetPassword: (input: Inputs['auth']['recovery']['resetPassword']) =>
      untypedClient.mutation('auth.recovery.resetPassword', input) as Promise<
        Outputs['auth']['recovery']['resetPassword']
      >,
  },
};

/**
 * Same pattern as `authApi` — see the note at the top of this file for
 * why it's hand-written instead of a typed proxy. Every one of these
 * procedures is a `protectedProcedure` (requires a valid access token),
 * so every call goes through `withAuthRetry` — see that function's doc
 * comment for why: without it, a `sendMessage` (or any other call here)
 * made after the access token's 15-minute TTL elapses fails with a
 * silent 401 that the UI can only show as a generic send/load failure.
 */
export const e2eeApi = {
  registerIdentityKey: (input: Inputs['e2ee']['registerIdentityKey']) =>
    withAuthRetry(() => untypedClient.mutation('e2ee.registerIdentityKey', input)) as Promise<
      Outputs['e2ee']['registerIdentityKey']
    >,

  registerDeviceCredential: (input: Inputs['e2ee']['registerDeviceCredential']) =>
    withAuthRetry(() => untypedClient.mutation('e2ee.registerDeviceCredential', input)) as Promise<
      Outputs['e2ee']['registerDeviceCredential']
    >,

  publishKeyPackages: (input: Inputs['e2ee']['publishKeyPackages']) =>
    withAuthRetry(() => untypedClient.mutation('e2ee.publishKeyPackages', input)) as Promise<
      Outputs['e2ee']['publishKeyPackages']
    >,

  consumeKeyPackage: (input: Inputs['e2ee']['consumeKeyPackage']) =>
    withAuthRetry(() => untypedClient.mutation('e2ee.consumeKeyPackage', input)) as Promise<
      Outputs['e2ee']['consumeKeyPackage']
    >,

  createConversation: (input: Inputs['e2ee']['createConversation']) =>
    withAuthRetry(() => untypedClient.mutation('e2ee.createConversation', input)) as Promise<
      Outputs['e2ee']['createConversation']
    >,

  listConversations: () =>
    withAuthRetry(() => untypedClient.query('e2ee.listConversations')) as Promise<Outputs['e2ee']['listConversations']>,

  sendMessage: (input: Inputs['e2ee']['sendMessage']) =>
    withAuthRetry(() => untypedClient.mutation('e2ee.sendMessage', input)) as Promise<Outputs['e2ee']['sendMessage']>,

  fetchMessages: (input: Inputs['e2ee']['fetchMessages']) =>
    withAuthRetry(() => untypedClient.query('e2ee.fetchMessages', input)) as Promise<Outputs['e2ee']['fetchMessages']>,

  listActiveDeviceIds: (input: Inputs['e2ee']['listActiveDeviceIds']) =>
    withAuthRetry(() => untypedClient.query('e2ee.listActiveDeviceIds', input)) as Promise<
      Outputs['e2ee']['listActiveDeviceIds']
    >,
};

export const usersApi = {
  search: (input: Inputs['users']['search']) =>
    withAuthRetry(() => untypedClient.query('users.search', input)) as Promise<Outputs['users']['search']>,

  updateProfile: (input: Inputs['users']['updateProfile']) =>
    withAuthRetry(() => untypedClient.mutation('users.updateProfile', input)) as Promise<Outputs['users']['updateProfile']>,
};

export const notificationsApi = {
  status: () =>
    withAuthRetry(() => untypedClient.query('notifications.status')) as Promise<Outputs['notifications']['status']>,

  registerPushToken: (input: Inputs['notifications']['registerPushToken']) =>
    withAuthRetry(() => untypedClient.mutation('notifications.registerPushToken', input)) as Promise<
      Outputs['notifications']['registerPushToken']
    >,

  unregisterPushToken: () =>
    withAuthRetry(() => untypedClient.mutation('notifications.unregisterPushToken')) as Promise<
      Outputs['notifications']['unregisterPushToken']
    >,
};

export const callsApi = {
  iceServers: () => withAuthRetry(() => untypedClient.query('calls.iceServers')) as Promise<Outputs['calls']['iceServers']>,

  status: () => withAuthRetry(() => untypedClient.query('calls.status')) as Promise<Outputs['calls']['status']>,
};

/** Turns a tRPC error, or a plain Error thrown by local orchestration code, into a message safe to show directly in the UI. */
export function getApiErrorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (err instanceof TRPCClientError) {
    return err.message || fallback;
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return fallback;
}
