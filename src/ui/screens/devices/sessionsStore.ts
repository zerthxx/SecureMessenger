import { useSyncExternalStore } from 'react';

import type { DeviceSession } from '@/domain/entities';
import { getApiErrorCode, getApiErrorMessage, sessionsApi } from '@/infrastructure/network/trpcClient';

/**
 * The account's sessions, shared by the Devices list and the Session details
 * screen so a termination made on one shows on the other at once. Loaded when
 * a Devices screen gains focus — never polled.
 */

export interface SessionsState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  sessions: DeviceSession[];
  autoTerminateDays: number | null;
  /** Why the last load failed; a list already on screen is kept. */
  error: string | null;
  /** Confirmation of the last successful action, e.g. "Session terminated." */
  notice: string | null;
}

const INITIAL_STATE: SessionsState = { status: 'idle', sessions: [], autoTerminateDays: null, error: null, notice: null };

let state = INITIAL_STATE;
const listeners = new Set<() => void>();
let loadInFlight: Promise<void> | null = null;
// Sessions ended from this app: a list response already in flight must not bring them back.
const terminatedIds = new Set<string>();
// Bumped on sign-out, so a response for the previous account is dropped.
let generation = 0;

function setState(patch: Partial<SessionsState>): void {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSessionsState(): SessionsState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Loads or refreshes the list. Concurrent calls share one request. */
export function loadSessions(): Promise<void> {
  if (loadInFlight) return loadInFlight;
  const requestGeneration = generation;
  if (state.status !== 'ready') setState({ status: 'loading', error: null });

  loadInFlight = sessionsApi
    .list()
    .then(
      (result) => {
        if (requestGeneration !== generation) return;
        setState({
          status: 'ready',
          sessions: result.sessions.filter((session) => !terminatedIds.has(session.id)),
          autoTerminateDays: result.autoTerminateDays,
          error: null,
        });
      },
      (err: unknown) => {
        if (requestGeneration !== generation) return;
        setState({
          status: state.status === 'ready' ? 'ready' : 'error',
          error: getApiErrorMessage(err, "Couldn't load your devices. Check your connection and try again."),
        });
      },
    )
    .finally(() => {
      loadInFlight = null;
    });
  return loadInFlight;
}

/** Terminates one session. It leaves the list immediately and returns only if the server refuses. */
export async function terminateSession(sessionId: string): Promise<void> {
  const previous = state.sessions;
  terminatedIds.add(sessionId);
  setState({ sessions: previous.filter((session) => session.id !== sessionId), notice: null });
  try {
    await sessionsApi.terminate({ sessionId });
  } catch (err) {
    // Already ended (e.g. from another device): the outcome the user wanted.
    if (getApiErrorCode(err) !== 'NOT_FOUND') {
      terminatedIds.delete(sessionId);
      setState({ sessions: previous });
      throw err;
    }
  }
  setState({ notice: 'Session terminated.' });
}

/** Terminates every session except this device's. */
export async function terminateOtherSessions(): Promise<number> {
  const previous = state.sessions;
  const others = previous.filter((session) => !session.isCurrent);
  for (const session of others) terminatedIds.add(session.id);
  setState({ sessions: previous.filter((session) => session.isCurrent), notice: null });
  try {
    const { terminatedCount } = await sessionsApi.terminateAllOthers();
    setState({ notice: terminatedCount === 1 ? '1 session terminated.' : `${terminatedCount} sessions terminated.` });
    return terminatedCount;
  } catch (err) {
    for (const session of others) terminatedIds.delete(session.id);
    setState({ sessions: previous });
    throw err;
  }
}

/** Saves the automatic-termination period; sessions it ends on the server are removed from the list. */
export async function setAutoTerminateDays(days: number): Promise<void> {
  const { autoTerminateDays, terminatedCount } = await sessionsApi.setAutoTerminate({ days });
  setState({
    autoTerminateDays,
    notice:
      terminatedCount === 0
        ? 'Setting saved.'
        : `Setting saved. ${terminatedCount === 1 ? '1 inactive session was' : `${terminatedCount} inactive sessions were`} terminated.`,
  });
  if (terminatedCount > 0) void loadSessions();
}

export function clearSessionsNotice(): void {
  if (state.notice) setState({ notice: null });
}

/** Forgets everything — called on sign-out. */
export function resetSessionsStore(): void {
  generation += 1;
  terminatedIds.clear();
  loadInFlight = null;
  state = INITIAL_STATE;
  for (const listener of [...listeners]) listener();
}
