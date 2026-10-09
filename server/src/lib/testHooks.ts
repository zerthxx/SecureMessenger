import { isProduction } from '../config/env.js';

/**
 * Fault injection for the group-rebuild protocol, used only by the
 * multi-device test runs against a local server (see
 * docs/ENGINEERING_CHECKLIST.md, "deterministic rebuild race"). Every hook
 * is read from the environment at startup and is ignored outright in
 * production, so a stray variable can never slow down or break a real
 * deployment.
 *
 * - E2EE_TEST_RESET_GROUP_DELAY_MS: `resetGroup` waits this long before its
 *   transaction, widening the window in which the rebuilding device holds a
 *   group the server hasn't accepted yet — the window the client's
 *   "label 0 + rebuild candidate" protection exists for.
 * - E2EE_TEST_DROP_RESET_RESPONSES: this many `resetGroup` calls are
 *   committed but answered by destroying the connection, so the client sees
 *   a lost response and must recover from its own retry / candidate note.
 */
const delayMs = isProduction ? 0 : Math.max(0, Number(process.env.E2EE_TEST_RESET_GROUP_DELAY_MS ?? 0) || 0);
let dropResponses = isProduction ? 0 : Math.max(0, Number(process.env.E2EE_TEST_DROP_RESET_RESPONSES ?? 0) || 0);

export function resetGroupTestDelayMs(): number {
  return delayMs;
}

/** True when this resetGroup response must be dropped (counts down). */
export function takeDroppedResetResponse(): boolean {
  if (dropResponses <= 0) return false;
  dropResponses -= 1;
  return true;
}

/**
 * E2EE_TEST_REALTIME_DOWN=1: every WebSocket upgrade to /realtime is
 * refused with 503, so connected apps fall back to polling — the way to
 * watch the poll-storm mitigation (docs/ENGINEERING_CHECKLIST.md, scale
 * readiness, S1) on real devices. HTTP keeps working.
 */
const realtimeDown = !isProduction && process.env.E2EE_TEST_REALTIME_DOWN === '1';

export function realtimeDownForTest(): boolean {
  return realtimeDown;
}

export function testHooksActive(): boolean {
  return delayMs > 0 || dropResponses > 0 || realtimeDown;
}
