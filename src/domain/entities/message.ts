export type MessageDirection = 'outgoing' | 'incoming';

/**
 * `decryption_failed` must always render as an explicit "can't display
 * this message" state — never a fallback to any other content. See the
 * Phase 6 report's security rule on this.
 */
export type MessageStatus = 'sending' | 'sent' | 'failed' | 'decrypted' | 'decryption_failed';

export type MessageKind = 'text' | 'voice';

/** Lifecycle of a voice message's audio blob on this device. */
export type AudioState = 'idle' | 'downloading' | 'downloaded' | 'failed';

export interface Message {
  id: string;
  conversationId: string;
  senderDeviceId: string;
  direction: MessageDirection;
  status: MessageStatus;
  kind: MessageKind;
  /** Only ever populated when `status === 'decrypted'` and `kind === 'text'`. */
  text: string | null;
  /** Voice-message metadata — only populated when `kind === 'voice'`. */
  audioMediaId: string | null;
  audioDurationMs: number | null;
  /** Local file uri, once the (recorded or downloaded) audio is available on-device. */
  audioLocalUri: string | null;
  audioState: AudioState | null;
  createdAt: string;
}
