import { base64ToBytes, bytesToBase64 } from '@/infrastructure/crypto/base64';
import { openCallSignal, sealCallSignal } from '@/infrastructure/crypto/mlsCore';
import { uuidToBytes } from '@/infrastructure/crypto/uuid';

export type CallMediaKind = 'audio' | 'video';

/**
 * What travels inside a sealed call payload. The server relays only the
 * sealed bytes (see mls-core call_signal.rs), so SDP — including the DTLS
 * fingerprints that authenticate the media connection — and ICE candidates
 * (network addresses) are readable only by the conversation's members.
 */
export type CallSignal =
  | { kind: 'offer'; sdp: string; media: CallMediaKind; sentAt: number; restart: boolean }
  | { kind: 'answer'; sdp: string }
  | { kind: 'candidate'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  /** Asks the caller to renegotiate after the callee lost connectivity (only the caller sends offers). */
  | { kind: 'restart-request' }
  /** Lets the other side show "muted" / "camera off". */
  | { kind: 'media-state'; micMuted: boolean; cameraOff: boolean };

/** The conversation's MLS group id is its UUID's bytes (see ChatContext). */
export async function sealSignal(conversationId: string, callId: string, signal: CallSignal): Promise<string> {
  const sealed = await sealCallSignal(uuidToBytes(conversationId), callId, JSON.stringify(signal));
  return bytesToBase64(sealed);
}

/** Null for anything that doesn't open (tampered, another call, not a member of the group) or isn't a well-formed signal. */
export async function openSignal(conversationId: string, callId: string, payload: string): Promise<CallSignal | null> {
  let json: string;
  try {
    json = await openCallSignal(uuidToBytes(conversationId), callId, base64ToBytes(payload));
  } catch {
    return null;
  }
  try {
    return parseSignal(JSON.parse(json));
  } catch {
    return null;
  }
}

function parseSignal(value: unknown): CallSignal | null {
  if (!value || typeof value !== 'object') return null;
  const signal = value as Record<string, unknown>;
  switch (signal.kind) {
    case 'offer':
      return typeof signal.sdp === 'string' &&
        (signal.media === 'audio' || signal.media === 'video') &&
        typeof signal.sentAt === 'number'
        ? { kind: 'offer', sdp: signal.sdp, media: signal.media, sentAt: signal.sentAt, restart: signal.restart === true }
        : null;
    case 'answer':
      return typeof signal.sdp === 'string' ? { kind: 'answer', sdp: signal.sdp } : null;
    case 'candidate':
      return typeof signal.candidate === 'string'
        ? {
            kind: 'candidate',
            candidate: signal.candidate,
            sdpMid: typeof signal.sdpMid === 'string' ? signal.sdpMid : null,
            sdpMLineIndex: typeof signal.sdpMLineIndex === 'number' ? signal.sdpMLineIndex : null,
          }
        : null;
    case 'restart-request':
      return { kind: 'restart-request' };
    case 'media-state':
      return typeof signal.micMuted === 'boolean' && typeof signal.cameraOff === 'boolean'
        ? { kind: 'media-state', micMuted: signal.micMuted, cameraOff: signal.cameraOff }
        : null;
    default:
      return null;
  }
}
