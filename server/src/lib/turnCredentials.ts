/**
 * Short-lived TURN relay credentials from Cloudflare Realtime TURN.
 *
 * A relay is what lets a call connect when the two phones can't reach each
 * other directly (symmetric NAT, carrier-grade NAT, restrictive Wi-Fi). It
 * only ever carries DTLS-SRTP packets it can't decrypt. The long-lived API
 * token stays on this server; apps only receive per-request credentials
 * that expire on their own.
 *
 * Kept free of env/config access so it can be unit-tested with a fake
 * `fetch`; lib/iceServers.ts wires it to TURN_KEY_ID / TURN_API_TOKEN.
 */

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface IceServerConfig {
  iceServers: IceServer[];
  /** Whether a relay (TURN) is included — without one, some networks can't connect calls. */
  relay: boolean;
  /** When the relay credentials stop working; null without a relay. */
  expiresAt: string | null;
}

/** Used when no TURN service is configured (or it is unreachable): direct connections only. */
export const STUN_ONLY: IceServerConfig = {
  iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }],
  relay: false,
  expiresAt: null,
};

/**
 * Longer than any realistic call: a relay allocation is refreshed with the
 * same credentials for as long as the call lasts, so they must not expire
 * mid-call. Cloudflare's guidance is to set the TTL above expected usage.
 */
export const TURN_CREDENTIAL_TTL_SECONDS = 8 * 60 * 60;

const API_BASE = 'https://rtc.live.cloudflare.com/v1/turn/keys';

/**
 * Validates Cloudflare's `generate-ice-servers` response. URLs on port 53 are
 * dropped: Cloudflare notes that port is widely blocked and only makes ICE
 * wait for it to time out.
 */
export function parseCloudflareIceServers(body: unknown): IceServer[] {
  const list = (body as { iceServers?: unknown } | null)?.iceServers;
  if (!Array.isArray(list)) throw new Error('TURN credential response has no iceServers list.');
  const servers: IceServer[] = [];
  for (const entry of list) {
    const value = (entry ?? {}) as { urls?: unknown; username?: unknown; credential?: unknown };
    const rawUrls: unknown[] = typeof value.urls === 'string' ? [value.urls] : Array.isArray(value.urls) ? value.urls : [];
    const urls = rawUrls.filter(
      (url): url is string => typeof url === 'string' && /^(stun|turns?):/.test(url) && !/:53(\?|$)/.test(url),
    );
    if (urls.length === 0) continue;
    const server: IceServer = { urls };
    if (typeof value.username === 'string' && typeof value.credential === 'string') {
      server.username = value.username;
      server.credential = value.credential;
    }
    servers.push(server);
  }
  return servers;
}

export interface TurnCredentialProvider {
  getIceServers(): Promise<IceServerConfig>;
}

export function createCloudflareTurnProvider({
  keyId,
  apiToken,
  ttlSeconds = TURN_CREDENTIAL_TTL_SECONDS,
  fetchImpl = fetch,
  now = Date.now,
}: {
  keyId: string;
  apiToken: string;
  ttlSeconds?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): TurnCredentialProvider {
  return {
    async getIceServers() {
      const response = await fetchImpl(`${API_BASE}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl: ttlSeconds }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw new Error(`TURN credential request failed: HTTP ${response.status}`);
      }
      const iceServers = parseCloudflareIceServers(await response.json());
      const relay = iceServers.some((server) => server.credential !== undefined && server.urls.some((url) => url.startsWith('turn')));
      if (!relay) {
        throw new Error('TURN credential response did not include a relay server.');
      }
      return { iceServers, relay, expiresAt: new Date(now() + ttlSeconds * 1000).toISOString() };
    },
  };
}
