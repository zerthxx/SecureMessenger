import { z } from 'zod';

/**
 * Wire protocol of the authenticated realtime WebSocket (`GET /realtime`).
 *
 * The server only routes these messages. Every call `payload` is opaque to
 * it: the app seals SDP offers/answers and ICE candidates with a key derived
 * from the conversation's MLS group (the MLS exporter, see
 * modules/mls-core `seal_call_signal`), so the server can't read them, can't
 * learn the peers' network candidates from them, and can't substitute its
 * own DTLS fingerprint to intercept the media, which flows peer to peer (or
 * through a TURN relay) over DTLS-SRTP.
 *
 * What the server does see: which account calls which, when, for how long,
 * audio vs. video, and the sizes/timing of signaling messages.
 */

/** Sealed SDP with ICE candidates is a few kilobytes; this leaves generous headroom. */
export const MAX_CALL_PAYLOAD_CHARS = 64_000;

const callId = z.string().uuid();
const payload = z
  .string()
  .min(1)
  .max(MAX_CALL_PAYLOAD_CHARS)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'payload must be base64');

export const callMediaSchema = z.enum(['audio', 'video']);
export type CallMedia = z.infer<typeof callMediaSchema>;

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  /** Swaps in a fresh access token before the current one expires, instead of reconnecting. */
  z.object({ type: z.literal('auth.refresh'), token: z.string().min(1).max(4096) }),
  z.object({ type: z.literal('call.invite'), callId, conversationId: z.string().uuid(), media: callMediaSchema, payload }),
  /** Sent by a callee device that was woken by a push, to receive the invite it missed while disconnected. */
  z.object({ type: z.literal('call.fetch'), callId }),
  z.object({ type: z.literal('call.ringing'), callId }),
  z.object({ type: z.literal('call.accept'), callId, payload }),
  z.object({ type: z.literal('call.decline'), callId, busy: z.boolean().optional() }),
  z.object({ type: z.literal('call.signal'), callId, payload }),
  z.object({ type: z.literal('call.hangup'), callId }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type CallEndReason =
  /** The other participant hung up an active call. */
  | 'hangup'
  /** The caller hung up before the call was answered. */
  | 'cancelled'
  | 'declined'
  /** The callee is already in another call, or declined as busy. */
  | 'busy'
  /** Nobody answered in time. */
  | 'timeout'
  /** The other participant's connection to the server stayed down past the reconnect grace period. */
  | 'connection_lost'
  /** Another device of the same account answered. */
  | 'answered_elsewhere'
  /** Another device of the same account declined. */
  | 'declined_elsewhere';

export type CallErrorCode = 'invalid_message' | 'rate_limited' | 'not_allowed' | 'already_in_call' | 'unavailable';

export type ServerEvent =
  | { type: 'ready' }
  | { type: 'pong' }
  | { type: 'auth.refreshed' }
  /**
   * Another device just signed in to this account. Describes the new session
   * (its id, device label, platform, coarse location if known, time) so the
   * app can alert the user — never any credential.
   */
  | { type: 'security.new_login'; sessionId: string; deviceName: string; platform: string; location: string | null; at: string }
  /** Content-free hint that a conversation has new rows to sync. */
  | { type: 'conversation.updated'; conversationId: string }
  | {
      type: 'call.incoming';
      callId: string;
      conversationId: string;
      callerUserId: string;
      media: CallMedia;
      payload: string;
      startedAt: string;
    }
  | { type: 'call.ringing'; callId: string }
  | { type: 'call.accepted'; callId: string; payload: string }
  | { type: 'call.signal'; callId: string; payload: string }
  | { type: 'call.ended'; callId: string; reason: CallEndReason }
  | { type: 'call.error'; callId?: string; code: CallErrorCode };

/** Parses one text frame; `null` for anything that isn't a well-formed client message. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = clientMessageSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
