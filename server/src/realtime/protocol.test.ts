import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MAX_CALL_PAYLOAD_CHARS, parseClientMessage } from './protocol.js';

const CALL = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';

describe('parseClientMessage', () => {
  test('accepts every well-formed client message', () => {
    assert.deepEqual(parseClientMessage('{"type":"ping"}'), { type: 'ping' });
    assert.deepEqual(
      parseClientMessage(JSON.stringify({ type: 'call.invite', callId: CALL, conversationId: CONVERSATION, media: 'video', payload: 'c2VhbGVk' })),
      { type: 'call.invite', callId: CALL, conversationId: CONVERSATION, media: 'video', payload: 'c2VhbGVk' },
    );
    assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'call.decline', callId: CALL })), { type: 'call.decline', callId: CALL });
    assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'call.decline', callId: CALL, busy: true })), {
      type: 'call.decline',
      callId: CALL,
      busy: true,
    });
  });

  test('rejects malformed JSON, unknown types, and bad ids', () => {
    assert.equal(parseClientMessage('not json'), null);
    assert.equal(parseClientMessage('{"type":"call.teleport"}'), null);
    assert.equal(parseClientMessage(JSON.stringify({ type: 'call.hangup', callId: 'nope' })), null);
    assert.equal(parseClientMessage(JSON.stringify({ type: 'call.invite', callId: CALL, conversationId: CONVERSATION, media: 'fax', payload: 'eA==' })), null);
  });

  test('call payloads must be bounded base64 — the server never accepts readable content', () => {
    const signal = (payload: string) => parseClientMessage(JSON.stringify({ type: 'call.signal', callId: CALL, payload }));
    assert.equal(signal('{"sdp":"v=0"}'), null);
    assert.equal(signal(''), null);
    assert.equal(signal('A'.repeat(MAX_CALL_PAYLOAD_CHARS + 1)), null);
    assert.notEqual(signal('A'.repeat(MAX_CALL_PAYLOAD_CHARS)), null);
  });
});
