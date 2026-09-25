/**
 * How the app tells a temporary server/network failure (worth retrying,
 * worth a calm message) from a permanent one (retrying can't help). Pure —
 * no React Native imports — so the rules are unit tested
 * (transientFailures.test.ts).
 *
 * Why this exists: a 504 from a CDN during an update download surfaced as
 * the raw native error ("Call to function 'FileSystem.downloadFileAsync'
 * has been rejected … status: 504") after ~7 seconds of retrying a single
 * host, and a 5xx while changing a profile photo read like the app had
 * failed rather than the server.
 */

/** HTTP statuses that describe a temporary condition on the server side or in between. */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** An HTTP failure with its status kept, so callers can decide on retrying without parsing messages. */
export class HttpStatusError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

/** A request that took longer than the caller was willing to wait. */
export class RequestTimeoutError extends Error {
  constructor(message = 'The request timed out.') {
    super(message);
    this.name = 'RequestTimeoutError';
  }
}

/**
 * The HTTP status behind an error, when there is one: an HttpStatusError's
 * own, or the one expo-file-system puts in its download error message
 * ("Unable to download a file: response has status: 504").
 */
export function statusOf(err: unknown): number | null {
  if (err instanceof HttpStatusError) return err.status;
  const text = err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? '')}` : String(err);
  const match = /status(?: code)?:?\s*(\d{3})\b/i.exec(text);
  return match ? Number(match[1]) : null;
}

/** Worth trying again: a transient status, a timeout, or no response at all (connection reset, offline). */
export function isRetryable(err: unknown): boolean {
  if (err instanceof RequestTimeoutError) return true;
  const status = statusOf(err);
  return status === null || isTransientStatus(status);
}

/**
 * Exponential backoff with full jitter, capped: attempt 0 waits up to
 * `baseMs`, attempt 1 up to 2×, … never more than `capMs`. Jitter keeps many
 * clients from retrying a recovering server in lockstep.
 */
export function backoffDelayMs(attempt: number, baseMs: number, capMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

/** What to tell the user about a failed update download, by cause — never the raw native error. */
export function updateDownloadFailureMessage(err: unknown): string {
  const status = statusOf(err);
  if (status !== null && isTransientStatus(status)) {
    return `The update server is temporarily unavailable (error ${status}). Please try again in a few minutes.`;
  }
  if (status === 404 || status === 410) {
    return 'This update is no longer available for download. Please check for updates again later.';
  }
  if (status !== null) {
    return `The update couldn't be downloaded (error ${status}). Please try again later.`;
  }
  return "The update couldn't be downloaded. Check your connection and try again.";
}

/**
 * Tries each source in turn, round after round, until one succeeds:
 * a source that fails permanently (404, 403, …) is dropped, one that
 * fails transiently is tried again next round, and rounds are separated by
 * a jittered, capped backoff. Always ends — after `maxRounds`, or as soon as
 * every source has failed permanently — with the last error.
 */
export async function tryAcrossSources<T>(
  sources: readonly string[],
  attempt: (source: string) => Promise<T>,
  options: {
    maxRounds: number;
    baseDelayMs: number;
    maxDelayMs: number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
  },
): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let alive = [...sources];
  let lastError: unknown = new Error('No download source is available.');
  for (let round = 0; round < options.maxRounds && alive.length > 0; round++) {
    if (round > 0) await sleep(backoffDelayMs(round - 1, options.baseDelayMs, options.maxDelayMs, options.random));
    for (const source of [...alive]) {
      try {
        return await attempt(source);
      } catch (err) {
        lastError = err;
        if (!isRetryable(err)) alive = alive.filter((s) => s !== source);
      }
    }
  }
  throw lastError;
}
