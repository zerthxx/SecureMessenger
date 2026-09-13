import { importPKCS8, SignJWT } from 'jose';

/**
 * Minimal Firebase Cloud Messaging (HTTP v1) client. FCM is the only
 * transport Android offers for waking an app that isn't running, so it is
 * what delivers a "new message" notification to a closed/backgrounded app
 * (the in-app poll only runs while the app is in the foreground).
 *
 * Kept free of env/config access so it can be unit-tested with a fake
 * `fetch`; lib/pushDelivery.ts wires it to FCM_SERVICE_ACCOUNT_JSON.
 */

export interface FcmServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

/** Android notification channel the app creates on the device (see src/infrastructure/notifications/pushNotifications.ts). */
export const MESSAGES_CHANNEL_ID = 'messages';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** Parses a Firebase service account key (the JSON file downloaded from the Firebase console). */
export function parseServiceAccount(json: string): FcmServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON is not valid JSON.');
  }
  const value = (parsed ?? {}) as Record<string, unknown>;
  const { project_id: projectId, client_email: clientEmail, private_key: privateKey } = value;
  if (
    typeof projectId !== 'string' ||
    projectId.length === 0 ||
    typeof clientEmail !== 'string' ||
    clientEmail.length === 0 ||
    typeof privateKey !== 'string' ||
    !privateKey.includes('PRIVATE KEY')
  ) {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON must be a Firebase service account key with project_id, client_email and private_key.');
  }
  return { projectId, clientEmail, privateKey };
}

export interface FcmMessage {
  message: {
    token: string;
    notification: { title: string; body: string };
    data: Record<string, string>;
    android: { priority: 'HIGH'; notification: { channel_id: string; tag: string } };
  };
}

/**
 * Deliberately generic. The server only ever holds MLS ciphertext, so it
 * cannot include message content, and naming the sender would hand the push
 * provider a record of who is talking to whom. The conversation id rides in
 * `data` so tapping the notification can open the right chat; the per-
 * conversation `tag` collapses repeated messages into one notification.
 */
export function buildNewMessagePush(token: string, conversationId: string): FcmMessage {
  return {
    message: {
      token,
      notification: { title: 'SecureMessenger', body: 'New message' },
      data: { type: 'new_message', conversationId },
      android: {
        priority: 'HIGH',
        notification: { channel_id: MESSAGES_CHANNEL_ID, tag: `conversation:${conversationId}` },
      },
    },
  };
}

export type FcmSendOutcome = 'sent' | 'invalid_token' | 'auth_error' | 'retryable' | 'failed';

/** Maps an FCM v1 `messages:send` response to what the caller should do about it. */
export function classifyFcmResponse(status: number, body: unknown): FcmSendOutcome {
  if (status >= 200 && status < 300) return 'sent';

  const error = (body as { error?: { status?: unknown; details?: unknown } } | null)?.error;
  const codes = new Set<string>();
  if (typeof error?.status === 'string') codes.add(error.status);
  if (Array.isArray(error?.details)) {
    for (const detail of error.details) {
      const code = (detail as { errorCode?: unknown } | null)?.errorCode;
      if (typeof code === 'string') codes.add(code);
    }
  }

  // The token no longer belongs to an installed app, is malformed, or was
  // issued for a different Firebase project — it will never work again.
  if (codes.has('UNREGISTERED') || codes.has('SENDER_ID_MISMATCH') || (status === 400 && codes.has('INVALID_ARGUMENT'))) {
    return 'invalid_token';
  }
  if (status === 401 || status === 403 || codes.has('THIRD_PARTY_AUTH_ERROR')) return 'auth_error';
  if (status === 429 || status >= 500 || codes.has('UNAVAILABLE') || codes.has('INTERNAL') || codes.has('QUOTA_EXCEEDED')) {
    return 'retryable';
  }
  return 'failed';
}

export interface FcmClient {
  send(message: FcmMessage): Promise<FcmSendOutcome>;
}

export function createFcmClient(account: FcmServiceAccount, fetchImpl: typeof fetch = fetch): FcmClient {
  let cached: { token: string; expiresAt: number } | null = null;

  async function getAccessToken(): Promise<string> {
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

    const key = await importPKCS8(account.privateKey, 'RS256');
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: FCM_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(account.clientEmail)
      .setSubject(account.clientEmail)
      .setAudience(TOKEN_URL)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);

    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    if (!response.ok) {
      throw new Error(`FCM access token request failed: HTTP ${response.status}`);
    }
    const json = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof json.access_token !== 'string') {
      throw new Error('FCM access token response did not include an access_token.');
    }
    const lifetimeSeconds = typeof json.expires_in === 'number' ? json.expires_in : 3600;
    cached = { token: json.access_token, expiresAt: Date.now() + lifetimeSeconds * 1000 };
    return cached.token;
  }

  return {
    async send(message) {
      const accessToken = await getAccessToken();
      const response = await fetchImpl(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.projectId)}/messages:send`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(message),
        },
      );
      if (response.status === 401) {
        cached = null; // force a fresh access token on the next send
      }
      const body = response.ok ? null : await response.json().catch(() => null);
      return classifyFcmResponse(response.status, body);
    },
  };
}
