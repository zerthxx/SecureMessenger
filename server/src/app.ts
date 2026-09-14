import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import websocket from '@fastify/websocket';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import fastify from 'fastify';

import { env, isProduction, trustProxyDisabledBehindProxy, trustProxyOption } from './config/env.js';
import { db } from './db/client.js';
import { apkDownloadRoutes } from './http/apkDownload.js';
import { avatarRoutes } from './http/avatars.js';
import { healthRoutes } from './http/health.js';
import { authenticateMediaRequest, isDeviceActive, mediaRoutes } from './http/media.js';
import { realtimeRoutes } from './http/realtime.js';
import { updateManifestRoutes } from './http/updateManifest.js';
import { loggerOptions } from './lib/logger.js';
import { avatarBlobStorage } from './lib/mediaStorage.js';
import { createDbProfileStore } from './lib/profileStore.js';
import { attachRealtimeLogger, createRealtimeRouteOptions } from './realtime/instance.js';
import { createContext } from './trpc/context.js';
import { appRouter, type AppRouter } from './trpc/router.js';

export function buildApp() {
  const app = fastify({
    logger: loggerOptions,
    routerOptions: { maxParamLength: 5000 },
    // Without this, `request.ip` is the socket peer — which behind a
    // platform edge proxy is the *proxy's* address for every request on
    // earth. Every `enforceRateLimit(...:ip:${ctx.req.ip})` bucket then
    // collapses into one globally shared counter: a single attacker
    // exhausting `login:ip` locks every user out of logging in, and the
    // signup availability check becomes a global chokepoint. See
    // config/env.ts for why this is a trusted-address list rather than
    // a hop count, and why that is the spoof-resistant choice.
    trustProxy: trustProxyOption,
  });

  if (trustProxyDisabledBehindProxy) {
    app.log.warn(
      'TRUST_PROXY is disabled in production: request.ip will be the socket peer for every request, ' +
        'so all per-IP rate limits share one global bucket. Set TRUST_PROXY to the trusted proxy CIDR(s).',
    );
  } else {
    app.log.info({ trustProxy: trustProxyOption }, 'proxy trust configured for client-IP resolution');
  }

  app.register(helmet);
  app.register(cors, { origin: env.CORS_ORIGIN });

  app.register(healthRoutes);
  app.register(updateManifestRoutes);
  app.register(apkDownloadRoutes, { prewarm: isProduction });
  app.register(mediaRoutes, { prefix: '/media' });
  app.register(avatarRoutes, {
    prefix: '/avatars',
    authenticate: authenticateMediaRequest,
    isDeviceActive,
    profiles: createDbProfileStore(db),
    blobs: avatarBlobStorage,
  });

  // Authenticated realtime channel: call signaling and "sync now" hints.
  app.register(websocket, { options: { maxPayload: 128 * 1024 } });
  attachRealtimeLogger(app.log);
  app.register(realtimeRoutes, createRealtimeRouteOptions());

  app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext,
      onError({ path, error }) {
        app.log.error({ err: error, path }, 'tRPC procedure error');
      },
    } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
  });

  return app;
}
