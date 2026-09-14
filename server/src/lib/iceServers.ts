import type { FastifyBaseLogger } from 'fastify';

import { env, isProduction } from '../config/env.js';
import {
  createCloudflareTurnProvider,
  parseCloudflareIceServers,
  STUN_ONLY,
  type IceServerConfig,
  type TurnCredentialProvider,
} from './turnCredentials.js';

/** A device reuses its relay credentials this long instead of minting new ones for every call attempt. */
const CACHE_MS = 30 * 60 * 1000;
const MAX_CACHED_DEVICES = 10_000;

let provider: TurnCredentialProvider | null | undefined;
const cache = new Map<string, { config: IceServerConfig; until: number }>();

function getProvider(): TurnCredentialProvider | null {
  if (provider === undefined) {
    provider =
      env.TURN_KEY_ID && env.TURN_API_TOKEN
        ? createCloudflareTurnProvider({ keyId: env.TURN_KEY_ID, apiToken: env.TURN_API_TOKEN })
        : null;
  }
  return provider;
}

/**
 * Local development only: a fixed ICE configuration, e.g. a TURN server on
 * the development machine so two emulators behind separate virtual NATs can
 * reach each other. Never used in production.
 */
function devIceServers(): IceServerConfig | null {
  if (isProduction || !env.DEV_ICE_SERVERS_JSON) return null;
  const iceServers = parseCloudflareIceServers({ iceServers: JSON.parse(env.DEV_ICE_SERVERS_JSON) });
  const relay = iceServers.some((server) => server.urls.some((url) => url.startsWith('turn')));
  return { iceServers, relay, expiresAt: null };
}

export function isTurnConfigured(): boolean {
  return getProvider() !== null;
}

/**
 * ICE servers for a call this device is placing or answering. Falls back to
 * STUN only (direct connections) when no TURN service is configured or it
 * can't be reached — the call may still connect, it just has no relay.
 */
export async function getIceServersForDevice(deviceId: string, log: Pick<FastifyBaseLogger, 'warn'>): Promise<IceServerConfig> {
  const dev = devIceServers();
  if (dev) return dev;

  const turn = getProvider();
  if (!turn) return STUN_ONLY;

  const cached = cache.get(deviceId);
  if (cached && cached.until > Date.now()) return cached.config;
  try {
    const config = await turn.getIceServers();
    if (cache.size >= MAX_CACHED_DEVICES) cache.clear();
    cache.set(deviceId, { config, until: Date.now() + CACHE_MS });
    return config;
  } catch (err) {
    log.warn({ err }, 'TURN credentials unavailable; calls fall back to direct connections');
    return STUN_ONLY;
  }
}
