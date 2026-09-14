import { PermissionsAndroid, Platform } from 'react-native';
import { mediaDevices, type MediaStream } from 'react-native-webrtc';

export interface CallPermissions {
  microphone: boolean;
  camera: boolean;
  /** A needed permission was denied with "don't ask again" — only system settings can change it now. */
  blocked: boolean;
}

/** Asks for the microphone, plus the camera for video calls. */
export async function requestCallPermissions(video: boolean): Promise<CallPermissions> {
  if (Platform.OS !== 'android') return { microphone: true, camera: video, blocked: false };
  const wanted = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, ...(video ? [PermissionsAndroid.PERMISSIONS.CAMERA] : [])];
  const results = await PermissionsAndroid.requestMultiple(wanted);
  const granted = (permission: (typeof wanted)[number]) => results[permission] === PermissionsAndroid.RESULTS.GRANTED;
  return {
    microphone: granted(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO),
    camera: video && granted(PermissionsAndroid.PERMISSIONS.CAMERA),
    blocked: wanted.some((permission) => results[permission] === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN),
  };
}

/** Microphone (with echo cancellation and noise suppression) and, when `video`, the front camera. */
export async function openLocalMedia(video: boolean): Promise<MediaStream> {
  return mediaDevices.getUserMedia({
    audio: true,
    video: video ? { facingMode: 'user', width: 1280, height: 720, frameRate: 30 } : false,
  });
}

/** Stops the camera/microphone capture behind a stream and frees its native resources. */
export function releaseStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
  stream.release();
}

/** A random RFC 4122 version 4 id. Call ids only need to be unique, not secret. */
export function newCallId(): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
