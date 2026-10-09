import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildVoiceEnvelope, parseVoiceEnvelope, VOICE_ENVELOPE_PREFIX } from './voiceEnvelope.ts';

// Run with `npm test` (Node's built-in runner; no React Native involved).

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; // 32 zero bytes, base64
const base = { mediaId: '11111111-1111-4111-8111-111111111111', durationMs: 4200, byteSize: 51234, mimeType: 'audio/m4a' };

describe('voice message envelopes', () => {
  test('a clip sealed with a content key carries that key, and it comes back out', () => {
    const text = buildVoiceEnvelope({ ...base, key: KEY });
    assert.ok(text.startsWith(VOICE_ENVELOPE_PREFIX));
    assert.deepEqual(parseVoiceEnvelope(text), { ...base, key: KEY });
  });

  test('an envelope from before content keys (the MLS-ratchet path) parses with no key', () => {
    const legacy = `${VOICE_ENVELOPE_PREFIX}${JSON.stringify(base)}`;
    assert.deepEqual(parseVoiceEnvelope(legacy), { ...base, key: null });
  });

  test('a key that is not 32 bytes of base64 is ignored rather than trusted', () => {
    for (const key of ['', 'short', 'not base64!!', KEY.slice(0, 20), KEY + KEY]) {
      assert.equal(parseVoiceEnvelope(`${VOICE_ENVELOPE_PREFIX}${JSON.stringify({ ...base, key })}`)?.key, null, JSON.stringify(key));
    }
  });

  test('ordinary text and malformed envelopes are not voice messages', () => {
    assert.equal(parseVoiceEnvelope('hello'), null);
    assert.equal(parseVoiceEnvelope(`${VOICE_ENVELOPE_PREFIX}not json`), null);
    assert.equal(parseVoiceEnvelope(`${VOICE_ENVELOPE_PREFIX}${JSON.stringify({ mediaId: 1 })}`), null);
  });
});
