import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { setAudioModeAsync, useAudioRecorder, useAudioRecorderState, type AudioRecorder } from 'expo-audio';

import {
  ensureRecordingPermission,
  MAX_RECORDING_MS,
  MIN_RECORDING_MS,
  releaseRecordingSlot,
  tryAcquireRecordingSlot,
  VOICE_RECORDING_OPTIONS,
} from '@/infrastructure/media/voiceRecording';

/**
 * `useAudioRecorder`'s native shared object can already be released by
 * the time our own effects run against it — expo-modules-core doesn't
 * guarantee its internal disposal effect runs after ours on unmount, and
 * in practice it can win the race (observed: a `CodedError` — "cannot
 * use shared object that was already released" — thrown SYNCHRONOUSLY
 * from a plain property read, not as a rejected promise). Every access
 * to `recorder` from a best-effort safety-net path (AppState listener,
 * unmount cleanup) must go through these, since a plain `.catch()` on
 * the result does nothing against a throw that happens before a promise
 * is even returned.
 */
function safeIsRecording(recorder: AudioRecorder): boolean {
  try {
    return recorder.isRecording;
  } catch {
    return false;
  }
}

function safeStopRecorder(recorder: AudioRecorder): void {
  try {
    recorder.stop()?.catch(() => {});
  } catch {
    // Already released — e.g. expo-audio's own hook disposed it as part
    // of this same unmount. Nothing left to stop; the mic is already off.
  }
}

export type VoiceRecorderPhase = 'idle' | 'requesting_permission' | 'permission_denied' | 'permission_blocked' | 'recording';

export interface VoiceRecordingResult {
  uri: string;
  durationMs: number;
}

export interface VoiceRecorderApi {
  phase: VoiceRecorderPhase;
  elapsedMs: number;
  start(): Promise<void>;
  /** Stops and returns the recorded file's uri + duration, or `null` if there's nothing usable (too short, or never started). */
  stop(): Promise<VoiceRecordingResult | null>;
  /** Stops (if recording) and discards. */
  cancel(): void;
}

/**
 * Thin, component-lifecycle-scoped wrapper around expo-audio's recording
 * hooks. `useAudioRecorder` already releases its native recorder on
 * unmount (covers navigating away from the conversation, and — since
 * logout unmounts this whole screen tree — logout mid-recording too);
 * this hook adds the app's own requirements on top: lazy permission
 * request, a hard max-duration auto-stop, and an AppState listener so
 * backgrounding the app never leaves the microphone open.
 *
 * `onMaxDurationReached` fires when the max-duration auto-stop kicks in
 * (as opposed to the caller explicitly tapping stop) — the caller should
 * treat it exactly like a manual `stop()` result (move to preview).
 */
export function useVoiceRecorder(onMaxDurationReached: (result: VoiceRecordingResult | null) => void): VoiceRecorderApi {
  const [phase, setPhase] = useState<VoiceRecorderPhase>('idle');
  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS);
  const recorderState = useAudioRecorderState(recorder, 100);
  const hasSlotRef = useRef(false);
  const onMaxDurationReachedRef = useRef(onMaxDurationReached);
  onMaxDurationReachedRef.current = onMaxDurationReached;

  const releaseSlotIfHeld = useCallback(() => {
    if (hasSlotRef.current) {
      releaseRecordingSlot();
      hasSlotRef.current = false;
    }
  }, []);

  const stop = useCallback(async (): Promise<VoiceRecordingResult | null> => {
    if (phase !== 'recording') return null;
    const durationMs = recorderState.durationMillis;
    try {
      await recorder.stop();
    } catch {
      // Recording failure (or the native object was already released out
      // from under us) — nothing usable to hand back.
      releaseSlotIfHeld();
      setPhase('idle');
      return null;
    }
    releaseSlotIfHeld();
    setPhase('idle');
    if (durationMs < MIN_RECORDING_MS) return null;
    let uri: string | null;
    try {
      uri = recorder.uri;
    } catch {
      return null; // released between the await above and this read — treat like any other stop failure
    }
    return uri ? { uri, durationMs } : null;
  }, [phase, recorder, recorderState.durationMillis, releaseSlotIfHeld]);

  // Never leave the mic open when the app backgrounds (incoming call,
  // home button, notification shade, etc.) — stop, don't just note it.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active' && safeIsRecording(recorder)) {
        safeStopRecorder(recorder);
        releaseSlotIfHeld();
        setPhase('idle');
      }
    });
    return () => subscription.remove();
  }, [recorder, releaseSlotIfHeld]);

  // Unmount safety net (navigating away mid-recording, or logout, which
  // unmounts this whole screen tree) — belt-and-suspenders on top of
  // useAudioRecorder's own automatic native release. Must use the `safe*`
  // helpers, not a direct property read/call: expo-audio's own release
  // effect can win the unmount race and free the native object before
  // this cleanup runs, and a read/call against an already-released
  // shared object throws synchronously (see the helpers' doc comment).
  useEffect(() => {
    return () => {
      if (safeIsRecording(recorder)) {
        safeStopRecorder(recorder);
      }
      releaseSlotIfHeld();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hard cap: auto-stop once MAX_RECORDING_MS is reached, routed through
  // the same `stop()` path a manual tap would take so callers only ever
  // have one "recording finished" code path to handle.
  useEffect(() => {
    if (phase === 'recording' && recorderState.durationMillis >= MAX_RECORDING_MS) {
      // Audit fix: stop() itself is designed to never reject (every
      // failure path inside it is caught and resolves to null/idle), but
      // this had no .catch — defense-in-depth in case a future change to
      // stop() or to the onMaxDurationReached callback itself throws, so
      // it surfaces as a caught, logged rejection instead of an
      // unhandled promise rejection.
      stop()
        .then((result) => onMaxDurationReachedRef.current(result))
        .catch((err) => console.warn('[useVoiceRecorder] max-duration auto-stop failed', err));
    }
  }, [phase, recorderState.durationMillis, stop]);

  const start = useCallback(async (): Promise<void> => {
    if (phase === 'recording' || phase === 'requesting_permission') return;
    if (!tryAcquireRecordingSlot()) return; // another recording is already active
    hasSlotRef.current = true;

    setPhase('requesting_permission');
    const permission = await ensureRecordingPermission();
    if (permission !== 'granted') {
      releaseSlotIfHeld();
      setPhase(permission === 'blocked' ? 'permission_blocked' : 'permission_denied');
      return;
    }

    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setPhase('recording');
    } catch {
      releaseSlotIfHeld();
      setPhase('idle');
    }
  }, [phase, recorder, releaseSlotIfHeld]);

  const cancel = useCallback((): void => {
    if (phase === 'recording') {
      safeStopRecorder(recorder);
    }
    releaseSlotIfHeld();
    setPhase('idle');
  }, [phase, recorder, releaseSlotIfHeld]);

  return {
    phase,
    elapsedMs: recorderState.durationMillis,
    start,
    stop,
    cancel,
  };
}
