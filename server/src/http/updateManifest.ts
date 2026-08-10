import type { FastifyInstance } from 'fastify';

import { CURRENT_UPDATE_MANIFEST } from '../config/updateManifest.js';

/**
 * Plain REST, not tRPC — same reasoning as health.ts: this is read by the
 * app's update-check flow before/independent of any auth state, and a
 * bare HTTP GET returning a small JSON object is simpler than wrapping it
 * in an RPC envelope for no benefit. Public and unauthenticated on
 * purpose — the client hasn't necessarily signed in yet when it checks
 * for an update, and there's nothing sensitive in a version number.
 */
export async function updateManifestRoutes(app: FastifyInstance) {
  app.get('/update-manifest', async () => CURRENT_UPDATE_MANIFEST);
}
