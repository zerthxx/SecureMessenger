import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchWithTimeout } from './fetchWithTimeout.ts';
import { isRetryable, RequestTimeoutError } from './transientFailures.ts';

/** A fetch that never answers on its own — like a request on a dead connection — and only settles when aborted. */
function hangingFetch(seen: { signal?: AbortSignal | null } = {}) {
  return (_input: string, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      seen.signal = init?.signal;
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      // Like real fetch: an already-aborted signal rejects straight away.
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener('abort', abort);
    });
}

test('a request that never answers is aborted at the deadline and reported as a retryable timeout', async () => {
  const seen: { signal?: AbortSignal | null } = {};
  const started = Date.now();
  await assert.rejects(fetchWithTimeout('https://example.test/trpc', {}, 30, hangingFetch(seen)), (err) => {
    assert.ok(err instanceof RequestTimeoutError);
    assert.ok(isRetryable(err));
    return true;
  });
  assert.ok(Date.now() - started < 1000);
  assert.equal(seen.signal?.aborted, true);
});

test('a response in time is returned untouched', async () => {
  const response = new Response('ok', { status: 200 });
  const result = await fetchWithTimeout('https://example.test/trpc', { method: 'POST' }, 1000, async (_input, init) => {
    assert.equal(init?.method, 'POST');
    return response;
  });
  assert.equal(result, response);
});

test('a network error is passed through as is, not relabelled as a timeout', async () => {
  const failure = new TypeError('Network request failed');
  await assert.rejects(
    fetchWithTimeout('https://example.test/trpc', {}, 1000, async () => {
      throw failure;
    }),
    (err) => err === failure,
  );
});

test("the caller's own cancellation still aborts the request, and is not reported as a timeout", async () => {
  const caller = new AbortController();
  const pending = fetchWithTimeout('https://example.test/trpc', { signal: caller.signal }, 10_000, hangingFetch());
  caller.abort();
  await assert.rejects(pending, (err) => !(err instanceof RequestTimeoutError));
});

test('an already-cancelled request is aborted straight away', async () => {
  const caller = new AbortController();
  caller.abort();
  const seen: { signal?: AbortSignal | null } = {};
  await assert.rejects(fetchWithTimeout('https://example.test/trpc', { signal: caller.signal }, 10_000, hangingFetch(seen)));
  assert.equal(seen.signal?.aborted, true);
});
