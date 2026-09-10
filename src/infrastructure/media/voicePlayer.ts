import { createAudioPlayer, type AudioPlayer, type AudioStatus } from 'expo-audio';

/**
 * Module-level singleton playback manager — "only one active voice-
 * message playback at a time," enforced structurally rather than by
 * convention: starting playback for any message tears down whatever
 * player (if any) was active for a different message first. Deliberately
 * NOT a hook (unlike recording, which is naturally scoped to the single
 * mounted composer) — playback can be triggered from any bubble in a
 * scrolled message list, so the player itself has to outlive any one
 * bubble component; UI subscribes via `subscribeVoicePlayback`.
 */

export interface VoicePlaybackState {
  messageId: string | null;
  playing: boolean;
  currentTime: number;
  duration: number;
}

let activePlayer: AudioPlayer | null = null;
let activeMessageId: string | null = null;
let removeStatusListener: (() => void) | null = null;

let state: VoicePlaybackState = { messageId: null, playing: false, currentTime: 0, duration: 0 };
const listeners = new Set<(state: VoicePlaybackState) => void>();

function setState(next: VoicePlaybackState): void {
  state = next;
  for (const listener of listeners) listener(state);
}

export function getVoicePlaybackState(): VoicePlaybackState {
  return state;
}

export function subscribeVoicePlayback(listener: (state: VoicePlaybackState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Releases the active player, if any. Safe to call when nothing is playing. */
export function stopVoicePlayback(): void {
  removeStatusListener?.();
  removeStatusListener = null;
  activePlayer?.remove();
  activePlayer = null;
  activeMessageId = null;
  setState({ messageId: null, playing: false, currentTime: 0, duration: 0 });
}

function onStatus(messageId: string, status: AudioStatus): void {
  if (activeMessageId !== messageId) return; // stale listener from a player we already tore down
  setState({ messageId, playing: status.playing, currentTime: status.currentTime, duration: status.duration });
  if (status.didJustFinish) {
    stopVoicePlayback();
  }
}

export function playVoiceMessage(messageId: string, uri: string): void {
  if (activeMessageId === messageId && activePlayer) {
    activePlayer.play();
    return;
  }
  stopVoicePlayback();

  const player = createAudioPlayer({ uri });
  activePlayer = player;
  activeMessageId = messageId;
  const subscription = player.addListener('playbackStatusUpdate', (status) => onStatus(messageId, status));
  removeStatusListener = () => subscription.remove();
  player.play();
  setState({ messageId, playing: true, currentTime: 0, duration: player.duration });
}

export function pauseVoiceMessage(messageId: string): void {
  if (activeMessageId === messageId) {
    activePlayer?.pause();
  }
}
