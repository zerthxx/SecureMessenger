// Ending a signed-out session on the server, without making the person wait
// for it. Signing out used to await the server first: on a dead or slow
// connection the app sat on a spinner until the request timed out (52 s in
// testing). Now the app signs out locally at once and this ends the session
// on the server in the background — retried at the next launch if the server
// can't be reached, so a session isn't left valid just because the phone was
// offline at the time. Pure (dependencies passed in) so the rules are unit
// tested (sessionRevocation.test.ts).

export interface EndedSession {
  accessToken: string;
  refreshToken: string;
}

export interface RevocationDeps {
  /** POSTs auth.logout with this access token; the HTTP status, or null when the server couldn't be reached. */
  logout(accessToken: string): Promise<number | null>;
  /** Exchanges the refresh token; 'ended' when the server rejects it (the session is over already), null when unreachable. */
  refresh(refreshToken: string): Promise<EndedSession | 'ended' | null>;
}

export type RevocationOutcome =
  | { done: true }
  /** Try again later, with these tokens (a refresh may have rotated them). */
  | { done: false; retryWith: EndedSession };

const isTransient = (status: number | null) => status === null || status === 408 || status === 429 || status >= 500;

export async function revokeSession(session: EndedSession, deps: RevocationDeps): Promise<RevocationOutcome> {
  const status = await deps.logout(session.accessToken);
  if (status === null || isTransient(status)) return { done: false, retryWith: session };
  if (status !== 401) return { done: true };

  // The access token expired (they last only minutes): renew it once to be
  // allowed to end the session.
  const renewed = await deps.refresh(session.refreshToken);
  if (renewed === 'ended') return { done: true };
  if (renewed === null) return { done: false, retryWith: session };
  const second = await deps.logout(renewed.accessToken);
  if (isTransient(second)) return { done: false, retryWith: renewed };
  return { done: true };
}

/** Most ended sessions kept for retrying; older ones expire on the server by themselves. */
export const MAX_PENDING_REVOCATIONS = 5;

/** Runs every pending revocation once; returns what is still pending. */
export async function revokeAll(pending: readonly EndedSession[], deps: RevocationDeps): Promise<EndedSession[]> {
  const still: EndedSession[] = [];
  for (const session of pending.slice(-MAX_PENDING_REVOCATIONS)) {
    try {
      const outcome = await revokeSession(session, deps);
      if (!outcome.done) still.push(outcome.retryWith);
    } catch {
      still.push(session);
    }
  }
  return still;
}
