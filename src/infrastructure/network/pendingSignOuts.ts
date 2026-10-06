// Ends signed-out sessions on the server in the background, and again at the
// next launch for any the server couldn't be told about (see
// sessionRevocation.ts for the rules).
import { getDeviceMetadata } from './deviceInfo';
import { MAX_PENDING_REVOCATIONS, revokeAll, type EndedSession, type RevocationDeps } from './sessionRevocation';
import { authApi, isUnauthorized, logoutWithToken } from './trpcClient';
import { loadPendingSignOuts, savePendingSignOuts } from '@/infrastructure/storage/secureAuthStorage';

const deps: RevocationDeps = {
  logout: logoutWithToken,
  refresh: async (refreshToken) => {
    try {
      const { session } = await authApi.refresh({ refreshToken, device: getDeviceMetadata() });
      return { accessToken: session.accessToken, refreshToken: session.refreshToken };
    } catch (err) {
      return isUnauthorized(err) ? 'ended' : null;
    }
  },
};

let running: Promise<void> | null = null;

/** One pass over every pending sign-out; never two at once (each could rotate the same refresh token). */
export function retryPendingSignOuts(): Promise<void> {
  running ??= (async () => {
    try {
      const pending = await loadPendingSignOuts();
      if (pending.length === 0) return;
      const left = await revokeAll(pending, deps);
      // Sign-outs queued while this pass ran are kept too.
      const queuedMeanwhile = (await loadPendingSignOuts()).filter((item) => !pending.some((p) => p.refreshToken === item.refreshToken));
      await savePendingSignOuts([...left, ...queuedMeanwhile].slice(-MAX_PENDING_REVOCATIONS));
    } catch {
      // Tried again at the next launch.
    } finally {
      running = null;
    }
  })();
  return running;
}

/** The app has signed out of `session` locally; this ends it on the server as soon as it can. */
export async function endSessionOnServer(session: EndedSession): Promise<void> {
  try {
    const pending = await loadPendingSignOuts();
    await savePendingSignOuts([...pending, session].slice(-MAX_PENDING_REVOCATIONS));
  } catch {
    // Storage failed: still try once now.
    await revokeAll([session], deps).catch(() => {});
    return;
  }
  await running;
  await retryPendingSignOuts();
}
