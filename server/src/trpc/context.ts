import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';

import { db } from '../db/client.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { sessions } from '../realtime/instance.js';

/**
 * Per-request tRPC context. `user`/`device` are populated from the
 * access token's signature + expiry only — deliberately no database hit
 * here, per the Phase 2 ADR (§05). Whether the session behind the token is
 * still live is checked afterwards by protectedProcedure through `sessions`
 * (lib/sessions.ts), which caches that answer briefly and knows about
 * terminations immediately — so a terminated device loses access at once
 * instead of keeping it for the rest of its token's ~15-minute lifetime.
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
    sessions,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
