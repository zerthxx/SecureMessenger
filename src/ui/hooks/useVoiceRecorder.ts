import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { getRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, type AudioRecorder } from 'expo-audio';

import {
  ensureRecordingPermission,
  MAX_RECORDING_MS,
  MIN_RECORDING_MS,
  releaseRecordingSlot,
  tryAcquireRecordingSlot,
  VOICE_RECORDING_OPTIONS,
} from '@/infrastructure/media/voiceRecording';
import { deleteVoiceFile } from '@/infrastructure/storage/voiceFiles';

/**
 * `useAudioRecorder`'s native shared object can already be released by
 * the time our own effects run against it — expo-modules-core doesn't
 * guarantee its internal disposal effect runs after ours on unmount, and
 * in practice it can win the race (observed: a `CodedError` — "cannot
 * use shared object that was already released" — thrown SYNCHRONOUSLY
 * from a plain property read, not as a rejected promise). Every access
 * to `recorder` from a best-effort safety-net path (AppState listener,
 * unmount cleanup, cancel) must go through these, since a plain `.catch()`
 * on the result does nothing against a throw that happens before a promise
 * is even returned.
 */
function safeIsRecording(recorder: AudioRecorder): boolean {
  try {
    return recorder.isRecording;
  } catch {
    return false;
  }
}

function safeUri(recorder: AudioRecorder): string | null {
  try {
    return recorder.uri;
  } catch {
    return null;
  }
}

/** Stops the recorder (if the native object still exists) and deletes the file it was writing. */
function safeStopAndDiscard(recorder: AudioRecorder): void {
  const uri = safeUri(recorder);
  const discard = () => {
    if (uri) {
      try {
        deleteVoiceFile(uri);
      } catch {
        // best effort — it's a cache file
      }
    }
  };
  try {
    const stopping = recorder.stop();
    if (stopping) {
      stopping.then(discard, discard);
      return;
    }
  } catch {
    // Already released — e.g. expo-audio's own hook disposed it as part
    // of this same unmount. Nothing left to stop; the mic is already off.
  }
  discard();
}

export type VoiceRecorderPhase = 'idle' | 'requesting_permission' | 'permission_denied' | 'permission_blocked' | 'recording';

export type VoiceRecordingStartResult =
  | 'recording'
  /** The permission prompt was just shown and accepted. Not recorded: the prompt interrupted the press, so the user presses again. */
  | 'permission_granted'
  | 'permission_denied'
  | 'permission_blocked'
  | 'busy'
  | 'failed';

export interface VoiceRecordingResult {
  uri: string;
  durationMs: number;
}

export interface VoiceRecorderApi {
  phase: VoiceRecorderPhase;
  elapsedMs: number;
  start(): Promise<VoiceRecordingStartResult>;
  /** Stops and returns the recorded file's uri + duration, or `null` if there's nothing usable (too short, or never started). */
  stop(): Promise<VoiceRecordingResult | null>;
  /** Stops (if recording) and discards the recording. */
  cancel(): void;
}

/** How often the elapsed time is read while (and only while) recording. */
const ELAPSED_POLL_MS = 100;

/**
 * Thin, component-lifecycle-scoped wrapper around expo-audio's recording
 * hooks. `useAudioRecorder` already releases its native recorder on
 * unmount (covers navigating away from the conversation, and — since
 * logout unmounts this whole screen tree — logout mid-recording too);
 * this hook adds the app's own requirements on top: lazy permission
 * request, a hard max-duration auto-stop, and an AppState listener so
 * backgrounding the app never leaves the microphone open.
 *
 * `stop`/`cancel` read the phase from a ref, not render state, so a press
 * that ends while `start()` is still preparing the recorder (a callback
 * captured before the phase changed) still stops the microphone.
 *
 * `onMaxDurationReached` fires when the max-duration auto-stop kicks in —
 * the caller should treat it exactly like a manual `stop()` result.
 */
export function useVoiceRecorder(onMaxDurationReached: (result: VoiceRecordingResult | null) => void): VoiceRecorderApi {
  const [phase, setPhaseState] = useState<VoiceRecorderPhase>('idle');
  const phaseRef = useRef<VoiceRecorderPhase>('idle');
  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS);
  const [elapsedMs, setElapsedMs] = useState(0);
  const durationRef = useRef(0);
  const hasSlotRef = useRef(false);
  const onMaxDurationReachedRef = useRef(onMaxDurationReached);
  onMaxDurationReachedRef.current = onMaxDurationReached;

  const setPhase = useCallback((next: VoiceRecorderPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const releaseSlotIfHeld = useCallback(() => {
    if (hasSlotRef.current) {
      releaseRecordingSlot();
      hasSlotRef.current = false;
    }
  }, []);

  const stop = useCallback(async (): Promise<VoiceRecordingResult | null> => {
    if (phaseRef.current !== 'recording') return null;
    const durationMs = durationRef.current;
    setPhase('idle');
    try {
      await recorder.stop();
    } catch {
      // Recording failure (or the native object was already released out
      // from under us) — nothing usable to hand back.
      releaseSlotIfHeld();
      return null;
    }
    releaseSlotIfHeld();
    const uri = safeUri(recorder);
    if (!uri) return null;
    if (durationMs < MIN_RECORDING_MS) {
      deleteVoiceFile(uri); // almost certainly an accidental press
      return null;
    }
    return { uri, durationMs };
  }, [recorder, releaseSlotIfHeld, setPhase]);

  // Never leave the mic open when the app backgrounds (incoming call,
  // home button, notification shade, etc.) — stop and discard.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active' && (phaseRef.current === 'recording' || safeIsRecording(recorder))) {
        safeStopAndDiscard(recorder);
        releaseSlotIfHeld();
        setPhase('idle');
      }
    });
    return () => subscription.remove();
  }, [recorder, releaseSlotIfHeld, setPhase]);

  // Unmount safety net (navigating away mid-recording, or logout, which
  // unmounts this whole screen tree) — belt-and-suspenders on top of
  // useAudioRecorder's own automatic native release.
  useEffect(() => {
    return () => {
      if (phaseRef.current === 'recording' || safeIsRecording(recorder)) {
        safeStopAndDiscard(recorder);
      }
      releaseSlotIfHeld();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Elapsed time is only read while recording. expo-audio's
  // useAudioRecorderState polled the native recorder every 100 ms for as
  // long as the composer was mounted, i.e. the whole time a chat was open.
  useEffect(() => {
    if (phase !== 'recording') return;
    const readElapsed = () => {
      try {
        const { durationMillis } = recorder.getStatus();
        durationRef.current = durationMillis;
        setElapsedMs(durationMillis);
      } catch {
        // Native recorder already released (see safeIsRecording) — nothing to read.
      }
    };
    readElapsed();
    const interval = setInterval(readElapsed, ELAPSED_POLL_MS);
    return () => clearInterval(interval);
  }, [phase, recorder]);

  // Hard cap: auto-stop once MAX_RECORDING_MS is reached, routed through
  // the same `stop()` path a manual release takes.
  useEffect(() => {
    if (phase === 'recording' && elapsedMs >= MAX_RECORDING_MS) {
      stop()
        .then((result) => onMaxDurationReachedRef.current(result))
        .catch((err) => console.warn('[useVoiceRecorder] max-duration auto-stop failed', err));
    }
  }, [phase, elapsedMs, stop]);

  const start = useCallback(async (): Promise<VoiceRecordingStartResult> => {
    if (phaseRef.current === 'recording' || phaseRef.current === 'requesting_permission') return 'busy';
    if (!tryAcquireRecordingSlot()) return 'busy'; // another recording is already active
    hasSlotRef.current = true;
    setPhase('requesting_permission');

    let alreadyGranted = false;
    try {
      alreadyGranted = (await getRecordingPermissionsAsync()).granted;
    } catch {
      alreadyGranted = false;
    }

    if (!alreadyGranted) {
      const permission = await ensureRecordingPermission();
      releaseSlotIfHeld();
      if (permission === 'granted') {
        setPhase('idle');
        return 'permission_granted';
      }
      setPhase(permission === 'blocked' ? 'permission_blocked' : 'permission_denied');
      return permission === 'blocked' ? 'permission_blocked' : 'permission_denied';
    }

    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      durationRef.current = 0;
      setElapsedMs(0);
      recorder.record();
      setPhase('recording');
      return 'recording';
    } catch {
      releaseSlotIfHeld();
      setPhase('idle');
      return 'failed';
    }
  }, [recorder, releaseSlotIfHeld, setPhase]);

  const cancel = useCallback((): void => {
    if (phaseRef.current === 'recording' || safeIsRecording(recorder)) {
      safeStopAndDiscard(recorder);
    }
    releaseSlotIfHeld();
    setPhase('idle');
  }, [recorder, releaseSlotIfHeld, setPhase]);

  return {
    phase,
    elapsedMs,
    start,
    stop,
    cancel,
  };
}
