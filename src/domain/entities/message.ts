export type MessageDirection = 'outgoing' | 'incoming';

/**
 * `decryption_failed` must always render as an explicit "can't display
 * this message" state — never a fallback to any other content. See the
 * Phase 6 report's security rule on this.
 */
export type MessageStatus = 'sending' | 'sent' | 'failed' | 'decrypted' | 'decryption_failed';

export interface Message {
  id: string;
  conversationId: string;
  senderDeviceId: string;
  direction: MessageDirection;
  status: MessageStatus;
  /** Only ever populated when `status === 'decrypted'`. */
  text: string | null;
  createdAt: string;
}
