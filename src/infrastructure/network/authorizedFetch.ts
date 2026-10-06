// Plain `fetch` with the app's access token, for the binary endpoints that
// don't fit tRPC's JSON transport (voice clips, profile photos). Reuses
// trpcClient.ts's access-token/refresh state instead of duplicating it, so
// every client always agrees on "who is authenticated right now."
import { fetchWithTimeout } from './fetchWithTimeout';
import { getAccessTokenForRequest, refreshAccessTokenOnce } from './trpcClient';

/**
 * Sends the request with the current access token; on a 401, refreshes the
 * token once (deduped with any tRPC refresh) and retries. With `timeoutMs`,
 * each attempt gives up after that long (see fetchWithTimeout).
 */
export async function authorizedFetch(url: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
  const send = (requestInit: RequestInit) =>
    timeoutMs === undefined ? fetch(url, requestInit) : fetchWithTimeout(url, requestInit, timeoutMs);
  const token = getAccessTokenForRequest();
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);

  let response = await send({ ...init, headers });
  if (response.status === 401) {
    const refreshed = await refreshAccessTokenOnce();
    if (refreshed) {
      const retryToken = getAccessTokenForRequest();
      const retryHeaders = new Headers(init.headers);
      if (retryToken) retryHeaders.set('authorization', `Bearer ${retryToken}`);
      response = await send({ ...init, headers: retryHeaders });
    }
  }
  return response;
}
