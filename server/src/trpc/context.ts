import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';

import { db } from '../db/client.js';
import { verifyAccessToken } from '../lib/tokens.js';

/**
 * Per-request tRPC context. `user`/`device` are populated from the
 * access token's signature + expiry only — deliberately no database hit
 * here, per the Phase 2 ADR (§05): that's what keeps the hot path fast.
 * A device revoked mid-lifetime of its access token stays "valid" for
 * at most ~15 minutes, which is the bound the short expiry exists to
 * guarantee.
 */
export async function createContext({ req, res }: CreateFastifyContextOptions) {
  let user: { id: string } | null = null;
  let device: { id: string } | null = null;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length);
    const verified = await verifyAccessToken(token);
    if (verified) {
      user = { id: verified.userId };
      device = { id: verified.deviceId };
    }
  }

  return {
    req,
    res,
    log: req.log,
    db,
    user,
    device,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
