// What to tell people when an API call failed before the server could answer
// it. Pure (no React Native imports) so the rules are unit tested
// (apiErrorMessage.test.ts).
//
// Why this exists: getApiErrorMessage showed a failed call's own message,
// which for anything but a real server answer is technical — "Network
// request failed" with no connection, or a JSON parse error when a proxy in
// front of the server answered with an HTML 502 page.

export const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection and try again.";
export const SERVER_UNAVAILABLE_MESSAGE = 'The server is temporarily unavailable. Please try again in a moment.';

interface ClientErrorLike {
  message?: string;
  data?: unknown;
  cause?: unknown;
}

/**
 * For a tRPC client error: the message to show instead of its own — or null
 * when the server itself answered (a tRPC error with a code), whose message
 * is written for people and is shown as is.
 */
export function transportFailureMessage(err: ClientErrorLike): string | null {
  const data = err.data as { code?: unknown } | null | undefined;
  if (data && typeof data.code === 'string') return null;

  const cause = err.cause as { name?: unknown; message?: unknown } | null | undefined;
  if (cause?.name === 'RequestTimeoutError' && typeof cause.message === 'string') return cause.message;
  const text = `${typeof err.message === 'string' ? err.message : ''} ${typeof cause?.message === 'string' ? cause.message : ''}`;
  if (cause?.name === 'TypeError' || /network request failed|fetch failed|failed to fetch|network error/i.test(text)) {
    return OFFLINE_MESSAGE;
  }
  // Something answered, but not the API (an HTML error page from a proxy,
  // an empty or cut-off body).
  return SERVER_UNAVAILABLE_MESSAGE;
}
