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

// 10.0.2.2 is the Android emulator's alias for the host machine's
// localhost — plain "localhost" would resolve to the emulator itself.
// Override with EXPO_PUBLIC_API_URL (Expo inlines EXPO_PUBLIC_* at
// build time, no extra config needed) once there's a real deployment.
const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:4000';

let currentAccessToken: string | null = null;

/** Called by AuthContext whenever the session changes — login, refresh, logout. */
export function setAccessToken(token: string | null): void {
  currentAccessToken = token;
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

  logout: () => untypedClient.mutation('auth.logout') as Promise<Outputs['auth']['logout']>,

  logoutAllDevices: () =>
    untypedClient.mutation('auth.logoutAllDevices') as Promise<Outputs['auth']['logoutAllDevices']>,

  changePassword: (input: Inputs['auth']['changePassword']) =>
    untypedClient.mutation('auth.changePassword', input) as Promise<Outputs['auth']['changePassword']>,

  recovery: {
    verifyCode: (input: Inputs['auth']['recovery']['verifyCode']) =>
      untypedClient.mutation('auth.recovery.verifyCode', input) as Promise<Outputs['auth']['recovery']['verifyCode']>,

    resetPassword: (input: Inputs['auth']['recovery']['resetPassword']) =>
      untypedClient.mutation('auth.recovery.resetPassword', input) as Promise<
        Outputs['auth']['recovery']['resetPassword']
      >,
  },
};

/** Same pattern as `authApi` — see the note at the top of this file for why it's hand-written instead of a typed proxy. */
export const e2eeApi = {
  registerIdentityKey: (input: Inputs['e2ee']['registerIdentityKey']) =>
    untypedClient.mutation('e2ee.registerIdentityKey', input) as Promise<Outputs['e2ee']['registerIdentityKey']>,

  registerDeviceCredential: (input: Inputs['e2ee']['registerDeviceCredential']) =>
    untypedClient.mutation('e2ee.registerDeviceCredential', input) as Promise<
      Outputs['e2ee']['registerDeviceCredential']
    >,

  publishKeyPackages: (input: Inputs['e2ee']['publishKeyPackages']) =>
    untypedClient.mutation('e2ee.publishKeyPackages', input) as Promise<Outputs['e2ee']['publishKeyPackages']>,

  consumeKeyPackage: (input: Inputs['e2ee']['consumeKeyPackage']) =>
    untypedClient.mutation('e2ee.consumeKeyPackage', input) as Promise<Outputs['e2ee']['consumeKeyPackage']>,

  createConversation: (input: Inputs['e2ee']['createConversation']) =>
    untypedClient.mutation('e2ee.createConversation', input) as Promise<Outputs['e2ee']['createConversation']>,

  listConversations: () =>
    untypedClient.query('e2ee.listConversations') as Promise<Outputs['e2ee']['listConversations']>,

  sendMessage: (input: Inputs['e2ee']['sendMessage']) =>
    untypedClient.mutation('e2ee.sendMessage', input) as Promise<Outputs['e2ee']['sendMessage']>,

  fetchMessages: (input: Inputs['e2ee']['fetchMessages']) =>
    untypedClient.query('e2ee.fetchMessages', input) as Promise<Outputs['e2ee']['fetchMessages']>,

  listActiveDeviceIds: (input: Inputs['e2ee']['listActiveDeviceIds']) =>
    untypedClient.query('e2ee.listActiveDeviceIds', input) as Promise<Outputs['e2ee']['listActiveDeviceIds']>,
};

export const usersApi = {
  search: (input: Inputs['users']['search']) =>
    untypedClient.query('users.search', input) as Promise<Outputs['users']['search']>,
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
