import { AudioQuality, getRecordingPermissionsAsync, IOSOutputFormat, requestRecordingPermissionsAsync, type RecordingOptions } from 'expo-audio';

/**
 * Voice-message recording format: mono AAC in an .m4a container — small,
 * clear-speech quality, and Android-compatible (MediaRecorder's standard
 * mpeg4/aac combination, played back fine by expo-audio's ExoPlayer-backed
 * player on the receiving side). Deliberately lower than either built-in
 * `RecordingPresets` (which default to stereo, 44.1kHz, 64-128kbps —
 * unnecessary for spoken voice notes and bigger than they need to be once
 * base64-inflated ~33% for the MLS `encryptMessage` string API — see
 * ChatContext's `sendVoiceMessage`).
 */
export const VOICE_RECORDING_OPTIONS: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 22050,
  numberOfChannels: 1,
  bitRate: 48000,
  android: {
    extension: '.m4a',
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
    audioSource: 'voice_communication',
  },
  ios: {
    extension: '.m4a',
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.MEDIUM,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: 'audio/webm',
    bitsPerSecond: 48000,
  },
};

/** Auto-stops a recording at this length — bounds blob size (base64 + MLS overhead) and upload/download time. */
export const MAX_RECORDING_MS = 120_000;

/** Below this, `stop()` discards the take instead of offering it for preview/send — almost certainly an accidental tap. */
export const MIN_RECORDING_MS = 500;

export type RecordingPermissionResult = 'granted' | 'denied' | 'blocked';

/**
 * Checks current mic permission and, if not already granted, prompts
 * once. Never called except from an explicit user action (the record
 * button) — see useVoiceRecorder's `start()`, the only caller. Returns
 * 'blocked' (as opposed to 'denied') when the OS reports the app can no
 * longer ask again, so the UI can offer "Open Settings" instead of
 * silently re-prompting in a loop.
 */
export async function ensureRecordingPermission(): Promise<RecordingPermissionResult> {
  const current = await getRecordingPermissionsAsync();
  if (current.granted) return 'granted';
  const requested = await requestRecordingPermissionsAsync();
  if (requested.granted) return 'granted';
  return requested.canAskAgain ? 'denied' : 'blocked';
}

// Cross-component "only one recording at a time" guard. A single
// composer is normally the only thing that could ever call `start()`,
// but this makes that invariant explicit and crash-proof rather than
// merely incidental.
let recordingActive = false;

export function tryAcquireRecordingSlot(): boolean {
  if (recordingActive) return false;
  recordingActive = true;
  return true;
}

export function releaseRecordingSlot(): void {
  recordingActive = false;
}
