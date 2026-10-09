import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  backoffDelayMs,
  HttpStatusError,
  isRetryable,
  isRetryableApiFailure,
  isTransientStatus,
  RequestTimeoutError,
  statusOf,
  tryAcrossSources,
  updateDownloadFailureMessage,
} from './transientFailures.ts';

/** The exact rejection expo-file-system produced in the reported screenshot. */
const EXPO_504 = new Error(
  "Call to function 'FileSystem.downloadFileAsync' has been rejected.\n→ Caused by: Unable to download a file: response has status: 504",
);

describe('transient failures', () => {
  test('gateway/server errors, timeouts and rate limits are transient; client errors are not', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(isTransientStatus(status), true, String(status));
    for (const status of [400, 401, 403, 404, 410, 413, 415]) assert.equal(isTransientStatus(status), false, String(status));
  });

  test("the status is read from expo-file-system's download error and from HttpStatusError", () => {
    assert.equal(statusOf(EXPO_504), 504);
    assert.equal(statusOf(new HttpStatusError(404, 'Not found')), 404);
    assert.equal(statusOf(new Error('Network request failed')), null);
  });

  test('retry a 504, a timeout or a dropped connection — never a 404', () => {
    assert.equal(isRetryable(EXPO_504), true);
    assert.equal(isRetryable(new RequestTimeoutError()), true);
    assert.equal(isRetryable(new Error('Network request failed')), true);
    assert.equal(isRetryable(new HttpStatusError(404, 'Not found')), false);
    assert.equal(isRetryable(new HttpStatusError(401, 'Unauthorized')), false);
  });

  test('backoff grows, is capped, and is jittered', () => {
    assert.equal(backoffDelayMs(0, 1000, 8000, () => 0), 500);
    assert.equal(backoffDelayMs(0, 1000, 8000, () => 1), 1000);
    assert.equal(backoffDelayMs(2, 1000, 8000, () => 1), 4000);
    assert.equal(backoffDelayMs(10, 1000, 8000, () => 1), 8000);
    assert.equal(backoffDelayMs(10, 1000, 8000, () => 0), 4000);
  });

  test('users see a plain explanation, never the raw native error', () => {
    const message = updateDownloadFailureMessage(EXPO_504);
    assert.match(message, /temporarily unavailable \(error 504\)/);
    assert.doesNotMatch(message, /FileSystem|downloadFileAsync|rejected/);
    assert.match(updateDownloadFailureMessage(new HttpStatusError(404, 'x')), /no longer available/);
    assert.match(updateDownloadFailureMessage(new Error('Network request failed')), /Check your connection/);
  });
});

describe('trying several download sources', () => {
  const noSleep = async () => {};

  test('a 504 from the primary falls through to the mirror right away', async () => {
    const tried: string[] = [];
    const result = await tryAcrossSources(
      ['github', 'mirror'],
      async (source) => {
        tried.push(source);
        if (source === 'github') throw EXPO_504;
        return `from ${source}`;
      },
      { maxRounds: 3, baseDelayMs: 1000, maxDelayMs: 8000, sleep: noSleep },
    );
    assert.equal(result, 'from mirror');
    assert.deepEqual(tried, ['github', 'mirror']);
  });

  test('transient failures are retried with backoff between rounds, then succeed', async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await tryAcrossSources(
      ['only'],
      async () => {
        calls += 1;
        if (calls < 3) throw EXPO_504;
        return 'ok';
      },
      { maxRounds: 5, baseDelayMs: 1000, maxDelayMs: 8000, sleep: async (ms) => void delays.push(ms), random: () => 1 },
    );
    assert.equal(result, 'ok');
    assert.deepEqual(delays, [1000, 2000]);
  });

  test('a permanent failure drops that source instead of retrying it', async () => {
    const tried: string[] = [];
    await assert.rejects(
      tryAcrossSources(
        ['gone', 'down'],
        async (source) => {
          tried.push(source);
          throw source === 'gone' ? new HttpStatusError(404, 'Not found') : EXPO_504;
        },
        { maxRounds: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep },
      ),
      (err) => statusOf(err) === 504,
    );
    assert.deepEqual(tried, ['gone', 'down', 'down', 'down']);
  });

  test('it always gives up: no infinite retry loop', async () => {
    let calls = 0;
    await assert.rejects(
      tryAcrossSources(
        ['a', 'b'],
        async () => {
          calls += 1;
          throw EXPO_504;
        },
        { maxRounds: 4, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep },
      ),
    );
    assert.equal(calls, 8);
  });
});

describe('deciding whether to send again automatically', () => {
  /** The shape @trpc/client gives a failed call: `data` only when the server itself answered. */
  const trpcError = (data: { code: string; httpStatus?: number } | null, message = 'x', cause?: Error) =>
    Object.assign(new Error(message), { name: 'TRPCClientError', data, cause });

  test('no answer at all, a timeout, a server error or a rate limit: worth another try', () => {
    assert.equal(isRetryableApiFailure(new RequestTimeoutError()), true);
    assert.equal(isRetryableApiFailure(trpcError(null, 'Network request failed', new TypeError('Network request failed'))), true);
    assert.equal(isRetryableApiFailure(trpcError(null, 'Unexpected token < in JSON')), true);
    assert.equal(isRetryableApiFailure(trpcError({ code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 })), true);
    assert.equal(isRetryableApiFailure(trpcError({ code: 'TOO_MANY_REQUESTS', httpStatus: 429 })), true);
    assert.equal(isRetryableApiFailure(trpcError({ code: 'TIMEOUT', httpStatus: 408 })), true);
    assert.equal(isRetryableApiFailure(new HttpStatusError(503, 'unavailable')), true);
    assert.equal(isRetryableApiFailure(new TypeError('Network request failed')), true);
  });

  test("the server's own refusal, and the app's own logic errors, are final", () => {
    assert.equal(isRetryableApiFailure(trpcError({ code: 'CONFLICT', httpStatus: 409 }, 'STALE_GROUP_GENERATION')), false);
    assert.equal(isRetryableApiFailure(trpcError({ code: 'FORBIDDEN', httpStatus: 403 })), false);
    assert.equal(isRetryableApiFailure(trpcError({ code: 'UNAUTHORIZED', httpStatus: 401 })), false);
    assert.equal(isRetryableApiFailure(trpcError({ code: 'BAD_REQUEST', httpStatus: 400 })), false);
    assert.equal(isRetryableApiFailure(trpcError({ code: 'PRECONDITION_FAILED', httpStatus: 412 })), false);
    assert.equal(isRetryableApiFailure(new HttpStatusError(404, 'gone')), false);
    assert.equal(isRetryableApiFailure(new Error('This conversation is not ready to send messages yet.')), false);
    assert.equal(isRetryableApiFailure(new Error('Signed out before this could finish.')), false);
  });
});
