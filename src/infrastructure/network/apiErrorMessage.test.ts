import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TRPCClientError } from '@trpc/client';

import { OFFLINE_MESSAGE, SERVER_UNAVAILABLE_MESSAGE, transportFailureMessage } from './apiErrorMessage.ts';
import { RequestTimeoutError } from './transientFailures.ts';

test("a real answer from the server keeps the server's own message", () => {
  const err = TRPCClientError.from({ error: { message: 'Incorrect username or password.', code: -32001, data: { code: 'UNAUTHORIZED', httpStatus: 401 } } });
  assert.equal(transportFailureMessage(err), null);
});

test('no connection reads as such, not as the raw native error', () => {
  const err = TRPCClientError.from(new TypeError('Network request failed'));
  assert.equal(transportFailureMessage(err), OFFLINE_MESSAGE);
});

test('a timeout keeps its own plain message', () => {
  const err = TRPCClientError.from(new RequestTimeoutError('The server took too long to respond. Please try again.'));
  assert.equal(transportFailureMessage(err), 'The server took too long to respond. Please try again.');
});

test("a proxy's HTML error page (unparseable answer) reads as the server being unavailable", () => {
  const err = TRPCClientError.from(new SyntaxError("JSON Parse error: Unexpected character: '<'"));
  assert.equal(transportFailureMessage(err), SERVER_UNAVAILABLE_MESSAGE);
});
