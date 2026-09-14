import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';

import { router } from './trpc.js';
import { authRouter } from './routers/auth.js';
import { callsRouter } from './routers/calls.js';
import { e2eeRouter } from './routers/e2ee.js';
import { notificationsRouter } from './routers/notifications.js';
import { systemRouter } from './routers/system.js';
import { usersRouter } from './routers/users.js';

export const appRouter = router({
  system: systemRouter,
  auth: authRouter,
  e2ee: e2eeRouter,
  users: usersRouter,
  notifications: notificationsRouter,
  calls: callsRouter,
});

export type AppRouter = typeof appRouter;

// Derived here (inside this package, where @trpc/server is a real
// dependency) and re-exported so the mobile client can import the
// resolved input/output shapes without needing @trpc/server in its own
// node_modules — see src/infrastructure/network/trpcClient.ts.
export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
