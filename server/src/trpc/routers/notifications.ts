import { TRPCError } from '@trpc/server';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';

import { devices } from '../../db/schema.js';
import { isPushDeliveryConfigured } from '../../lib/pushDelivery.js';
import { enforceRateLimit, protectedProcedure, router } from '../trpc.js';

/**
 * Push token registration for the device making the call. The token is the
 * FCM registration token the app gets from the OS; `devices.push_token` has
 * existed since the initial schema but nothing wrote to it before this.
 */
export const notificationsRouter = router({
  /** Whether the server can actually deliver pushes (FCM credentials configured), so the app can say so instead of implying it works. */
  status: protectedProcedure.query(() => ({ deliveryConfigured: isPushDeliveryConfigured() })),

  registerPushToken: protectedProcedure
    .input(z.object({ token: z.string().trim().min(1).max(4096), provider: z.literal('fcm') }))
    .mutation(async ({ ctx, input }) => {
      enforceRateLimit(`notifications:register:device:${ctx.device.id}`, 20, 10 * 60 * 1000);

      // A token identifies one app install. If another device row still
      // holds it (a different account signed in on this same phone
      // earlier), take it away so that account stops getting this phone's
      // notifications.
      await ctx.db
        .update(devices)
        .set({ pushToken: null })
        .where(and(eq(devices.pushToken, input.token), ne(devices.id, ctx.device.id)));

      const [device] = await ctx.db
        .update(devices)
        .set({ pushToken: input.token })
        .where(and(eq(devices.id, ctx.device.id), eq(devices.userId, ctx.user.id), isNull(devices.revokedAt)))
        .returning({ id: devices.id });

      if (!device) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'This device has been signed out.' });
      }
      return { registered: true as const, deliveryConfigured: isPushDeliveryConfigured() };
    }),

  unregisterPushToken: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db
      .update(devices)
      .set({ pushToken: null })
      .where(and(eq(devices.id, ctx.device.id), eq(devices.userId, ctx.user.id)));
    return { success: true as const };
  }),
});
