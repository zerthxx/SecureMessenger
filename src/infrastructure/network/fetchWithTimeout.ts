// A deadline for plain `fetch`. React Native's Android HTTP client (OkHttp,
// see OkHttpClientProvider) is built with connect/read/write timeouts of 0 —
// none at all — so a request on a connection that died without a reset (a
// Wi-Fi ↔ mobile switch, a NAT that forgot the flow) never settles. Every
// queue waiting on such a request stalls with it: a conversation's sync, its
// in-order sends, a token refresh. Pure (no React Native imports) so it is
// unit tested (fetchWithTimeout.test.ts).
import { RequestTimeoutError } from './transientFailures.ts';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * `fetch` that rejects with RequestTimeoutError once `timeoutMs` passes
 * without a response. React Native's fetch resolves only after the whole
 * body has arrived, so the deadline covers the full transfer. A signal
 * already on `init` (e.g. tRPC cancelling a request) still aborts it.
 */
export async function fetchWithTimeout(
  input: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = init?.signal ?? null;
  const forwardAbort = () => controller.abort();
  if (callerSignal?.aborted) controller.abort();
  else callerSignal?.addEventListener('abort', forwardAbort);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) throw new RequestTimeoutError('The server took too long to respond. Please try again.');
    throw err;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', forwardAbort);
  }
}
