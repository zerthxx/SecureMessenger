import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import fastify from 'fastify';

import { env } from './config/env.js';
import { healthRoutes } from './http/health.js';
import { updateManifestRoutes } from './http/updateManifest.js';
import { loggerOptions } from './lib/logger.js';
import { createContext } from './trpc/context.js';
import { appRouter, type AppRouter } from './trpc/router.js';

export function buildApp() {
  const app = fastify({
    logger: loggerOptions,
    routerOptions: { maxParamLength: 5000 },
  });

  app.register(helmet);
  app.register(cors, { origin: env.CORS_ORIGIN });

  app.register(healthRoutes);
  app.register(updateManifestRoutes);

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
