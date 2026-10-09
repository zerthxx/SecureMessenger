/**
 * The small message that carries a voice clip's metadata through the
 * ordinary protected message path (`encryptMessage`/`sendMessage`/
 * `fetchMessages`/`decryptMessage` — see mlsCore.ts): a JSON envelope with
 * a prefix no typed text starts with. The audio itself never travels this
 * way — it is sealed under `key` and uploaded as an opaque blob (see
 * rust/src/blob.rs and ChatContext's `attemptSendVoice`).
 *
 * `key` is the clip's content key, base64. Envelopes from app versions
 * before content keys have none: their clips were MLS application messages
 * and are decrypted through the group (ChatContext's legacy path). Pure —
 * no React Native imports — so it is unit tested (voiceEnvelope.test.ts).
 */

export const VOICE_ENVELOPE_PREFIX = 'SMVOICE1:';

/** base64 of exactly 32 bytes: 44 characters ending in one `=`. */
const CONTENT_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

export interface VoiceEnvelope {
  mediaId: string;
  durationMs: number;
  byteSize: number;
  mimeType: string;
  /** The clip's content key (base64, 32 bytes), or null for a clip from before content keys. */
  key: string | null;
}

export function buildVoiceEnvelope(envelope: VoiceEnvelope): string {
  const { key, ...rest } = envelope;
  return VOICE_ENVELOPE_PREFIX + JSON.stringify(key ? { ...rest, key } : rest);
}

export function parseVoiceEnvelope(plaintext: string): VoiceEnvelope | null {
  if (!plaintext.startsWith(VOICE_ENVELOPE_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(plaintext.slice(VOICE_ENVELOPE_PREFIX.length));
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as VoiceEnvelope).mediaId === 'string' &&
      typeof (parsed as VoiceEnvelope).durationMs === 'number' &&
      typeof (parsed as VoiceEnvelope).byteSize === 'number' &&
      typeof (parsed as VoiceEnvelope).mimeType === 'string'
    ) {
      const { mediaId, durationMs, byteSize, mimeType, key } = parsed as Record<string, unknown>;
      return {
        mediaId: mediaId as string,
        durationMs: durationMs as number,
        byteSize: byteSize as number,
        mimeType: mimeType as string,
        key: typeof key === 'string' && CONTENT_KEY_RE.test(key) ? key : null,
      };
    }
  } catch {
    // Not a (parseable) voice envelope — never thrown further; the caller
    // treats this as an ordinary text message.
  }
  return null;
}
