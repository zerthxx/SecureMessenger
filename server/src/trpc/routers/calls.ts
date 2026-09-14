import { getIceServersForDevice, isTurnConfigured } from '../../lib/iceServers.js';
import { enforceRateLimit, protectedProcedure, router } from '../trpc.js';

/**
 * Call setup that isn't signaling (signaling runs over the realtime
 * WebSocket — see http/realtime.ts).
 */
export const callsRouter = router({
  /**
   * ICE servers for a call this device is about to place or answer: STUN,
   * plus TURN relay credentials minted for this device when a TURN service is
   * configured. Rate-limited because responses can carry fresh relay
   * credentials, and relay traffic is billed.
   */
  iceServers: protectedProcedure.query(async ({ ctx }) => {
    enforceRateLimit(`calls:iceServers:device:${ctx.device.id}`, 60, 60 * 60 * 1000);
    return getIceServersForDevice(ctx.device.id, ctx.log);
  }),

  /** Whether a relay is configured, so the app can explain a call that can't connect on a restrictive network. */
  status: protectedProcedure.query(() => ({ relayConfigured: isTurnConfigured() })),
});
