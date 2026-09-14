import type { CallEndReason, CallMedia, ServerEvent } from './protocol.js';

/**
 * Server-side call state: which calls are ringing or active, and where each
 * signaling message has to go. It never interprets payloads (see
 * protocol.ts) and holds no media — media never touches this server.
 *
 * Pure and synchronous: delivery, push wake-ups and timers are injected, so
 * the whole state machine is unit-tested without sockets or a database.
 */

export interface CallParticipant {
  userId: string;
  deviceId: string;
}

export interface CallSnapshot {
  callId: string;
  conversationId: string;
  media: CallMedia;
  callerUserId: string;
  callerDeviceId: string;
  calleeUserId: string;
}

export interface CallOutbox {
  /** Returns whether the device is connected and got the event. */
  toDevice(deviceId: string, event: ServerEvent): boolean;
  /** Returns the connected device ids of the account that got the event. */
  toUser(userId: string, event: ServerEvent, options?: { exceptDeviceId?: string }): string[];
  /** Wakes the callee's devices that aren't connected (push), so a closed app can ring. */
  wakeCallee(call: CallSnapshot, connectedDeviceIds: string[]): void;
  /** Tells devices that were woken that the call is over, so they stop ringing. */
  cancelWake(call: CallSnapshot, reason: CallEndReason): void;
}

export interface CallTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

export const systemTimers: CallTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/** How long an unanswered call rings. */
export const RING_TIMEOUT_MS = 45_000;
/** How long a participant's signaling connection may stay down (app restart, network switch) before their call ends. Media keeps flowing meanwhile. */
export const RECONNECT_GRACE_MS = 30_000;
/** Caller ICE candidates kept for a callee device that connects after being woken. */
const MAX_BUFFERED_SIGNALS = 64;

interface Call extends CallSnapshot {
  state: 'ringing' | 'active';
  offer: string;
  startedAt: number;
  calleeDeviceId: string | null;
  ringingSent: boolean;
  woken: boolean;
  bufferedCallerSignals: string[];
  ringTimer: unknown;
  graceTimers: Map<string, unknown>;
}

export type InviteResult = 'ringing' | 'busy' | 'duplicate' | 'already_in_call';

export class CallRegistry {
  private readonly calls = new Map<string, Call>();

  constructor(
    private readonly outbox: CallOutbox,
    private readonly timers: CallTimers = systemTimers,
  ) {}

  /** Number of calls ringing or active — exposed for tests and diagnostics. */
  get size(): number {
    return this.calls.size;
  }

  isUserInCall(userId: string): boolean {
    for (const call of this.calls.values()) {
      if (call.callerUserId === userId || call.calleeUserId === userId) return true;
    }
    return false;
  }

  /**
   * Starts ringing `calleeUserId`. The caller must already be verified as a
   * member of `conversationId` and `calleeUserId` as its other member.
   */
  invite(
    from: CallParticipant,
    input: { callId: string; conversationId: string; media: CallMedia; payload: string },
    calleeUserId: string,
  ): InviteResult {
    if (this.calls.has(input.callId)) return 'duplicate';
    if (this.isUserInCall(from.userId)) return 'already_in_call';
    if (this.isUserInCall(calleeUserId)) {
      this.outbox.toDevice(from.deviceId, { type: 'call.ended', callId: input.callId, reason: 'busy' });
      return 'busy';
    }

    const call: Call = {
      callId: input.callId,
      conversationId: input.conversationId,
      media: input.media,
      callerUserId: from.userId,
      callerDeviceId: from.deviceId,
      calleeUserId,
      state: 'ringing',
      offer: input.payload,
      startedAt: this.timers.now(),
      calleeDeviceId: null,
      ringingSent: false,
      woken: false,
      bufferedCallerSignals: [],
      ringTimer: null,
      graceTimers: new Map(),
    };
    this.calls.set(call.callId, call);

    const reached = this.outbox.toUser(calleeUserId, this.incomingEvent(call));
    this.outbox.wakeCallee(snapshot(call), reached);
    call.woken = true;
    call.ringTimer = this.timers.set(() => this.end(call, { caller: 'timeout', callee: 'timeout' }), RING_TIMEOUT_MS);
    return 'ringing';
  }

  /** A callee device (typically just woken by a push) asks for the invite it missed. */
  fetch(from: CallParticipant, callId: string): void {
    const call = this.calls.get(callId);
    if (!call || from.userId !== call.calleeUserId) {
      this.outbox.toDevice(from.deviceId, { type: 'call.ended', callId, reason: 'cancelled' });
      return;
    }
    if (call.state === 'active') {
      if (call.calleeDeviceId !== from.deviceId) {
        this.outbox.toDevice(from.deviceId, { type: 'call.ended', callId, reason: 'answered_elsewhere' });
      }
      return;
    }
    this.outbox.toDevice(from.deviceId, this.incomingEvent(call));
    for (const payload of call.bufferedCallerSignals) {
      this.outbox.toDevice(from.deviceId, { type: 'call.signal', callId, payload });
    }
  }

  /** A callee device is showing the incoming call — the caller hears "ringing". */
  ringing(from: CallParticipant, callId: string): void {
    const call = this.calls.get(callId);
    if (!call || call.state !== 'ringing' || from.userId !== call.calleeUserId || call.ringingSent) return;
    call.ringingSent = true;
    this.outbox.toDevice(call.callerDeviceId, { type: 'call.ringing', callId });
  }

  accept(from: CallParticipant, callId: string, payload: string): void {
    const call = this.calls.get(callId);
    if (!call || from.userId !== call.calleeUserId) {
      this.outbox.toDevice(from.deviceId, { type: 'call.ended', callId, reason: 'cancelled' });
      return;
    }
    if (call.state === 'active') {
      if (call.calleeDeviceId !== from.deviceId) {
        this.outbox.toDevice(from.deviceId, { type: 'call.ended', callId, reason: 'answered_elsewhere' });
      }
      return;
    }
    call.state = 'active';
    call.calleeDeviceId = from.deviceId;
    call.bufferedCallerSignals = [];
    this.timers.clear(call.ringTimer);
    call.ringTimer = null;
    this.outbox.toDevice(call.callerDeviceId, { type: 'call.accepted', callId, payload });
    this.outbox.toUser(call.calleeUserId, { type: 'call.ended', callId, reason: 'answered_elsewhere' }, { exceptDeviceId: from.deviceId });
    if (call.woken) this.outbox.cancelWake(snapshot(call), 'answered_elsewhere');
  }

  decline(from: CallParticipant, callId: string, busy = false): void {
    const call = this.calls.get(callId);
    if (!call || call.state !== 'ringing' || from.userId !== call.calleeUserId) return;
    this.end(call, { caller: busy ? 'busy' : 'declined', callee: 'declined_elsewhere' }, from.deviceId);
  }

  signal(from: CallParticipant, callId: string, payload: string): void {
    const call = this.calls.get(callId);
    if (!call) return;
    const event: ServerEvent = { type: 'call.signal', callId, payload };
    if (call.state === 'ringing') {
      // Only the caller has anything to trickle before an answer.
      if (from.deviceId !== call.callerDeviceId) return;
      if (call.bufferedCallerSignals.length < MAX_BUFFERED_SIGNALS) call.bufferedCallerSignals.push(payload);
      this.outbox.toUser(call.calleeUserId, event);
      return;
    }
    if (from.deviceId === call.callerDeviceId && call.calleeDeviceId) {
      this.outbox.toDevice(call.calleeDeviceId, event);
    } else if (from.deviceId === call.calleeDeviceId) {
      this.outbox.toDevice(call.callerDeviceId, event);
    }
  }

  hangup(from: CallParticipant, callId: string): void {
    const call = this.calls.get(callId);
    if (!call) return;
    if (call.state === 'ringing') {
      if (from.deviceId === call.callerDeviceId) {
        this.end(call, { caller: 'cancelled', callee: 'cancelled' }, from.deviceId);
      } else if (from.userId === call.calleeUserId) {
        this.end(call, { caller: 'declined', callee: 'declined_elsewhere' }, from.deviceId);
      }
      return;
    }
    if (from.deviceId === call.callerDeviceId || from.deviceId === call.calleeDeviceId) {
      this.end(call, { caller: 'hangup', callee: 'hangup' }, from.deviceId);
    }
  }

  /** The device's signaling connection dropped: end its calls unless it reconnects within the grace period. */
  deviceDisconnected(deviceId: string): void {
    for (const call of this.calls.values()) {
      const isCaller = call.callerDeviceId === deviceId;
      const isActiveCallee = call.calleeDeviceId === deviceId;
      if (!isCaller && !isActiveCallee) continue;
      if (call.graceTimers.has(deviceId)) continue;
      const handle = this.timers.set(() => {
        call.graceTimers.delete(deviceId);
        if (this.calls.get(call.callId) !== call) return;
        if (call.state === 'ringing' && isCaller) {
          this.end(call, { caller: 'cancelled', callee: 'cancelled' }, deviceId);
        } else {
          this.end(call, { caller: 'connection_lost', callee: 'connection_lost' }, deviceId);
        }
      }, RECONNECT_GRACE_MS);
      call.graceTimers.set(deviceId, handle);
    }
  }

  /**
   * The device's session was terminated: end its calls right away. Unlike a
   * dropped connection there is no reconnect grace period — the device can't
   * come back. The other side is told the connection was lost.
   */
  deviceRevoked(deviceId: string): void {
    for (const call of [...this.calls.values()]) {
      if (call.callerDeviceId === deviceId) {
        const reason = call.state === 'ringing' ? 'cancelled' : 'connection_lost';
        this.end(call, { caller: reason, callee: reason }, deviceId);
      } else if (call.calleeDeviceId === deviceId) {
        this.end(call, { caller: 'connection_lost', callee: 'connection_lost' }, deviceId);
      }
    }
  }

  deviceConnected(deviceId: string): void {
    for (const call of this.calls.values()) {
      const handle = call.graceTimers.get(deviceId);
      if (handle === undefined) continue;
      this.timers.clear(handle);
      call.graceTimers.delete(deviceId);
    }
  }

  private incomingEvent(call: Call): ServerEvent {
    return {
      type: 'call.incoming',
      callId: call.callId,
      conversationId: call.conversationId,
      callerUserId: call.callerUserId,
      media: call.media,
      payload: call.offer,
      startedAt: new Date(call.startedAt).toISOString(),
    };
  }

  /**
   * Removes the call and tells everyone still involved why it ended. The
   * device that caused the end (hung up, declined) already knows and isn't
   * told again.
   */
  private end(call: Call, reasons: { caller: CallEndReason; callee: CallEndReason }, causedByDeviceId?: string): void {
    if (this.calls.get(call.callId) !== call) return;
    this.calls.delete(call.callId);
    if (call.ringTimer) this.timers.clear(call.ringTimer);
    for (const handle of call.graceTimers.values()) this.timers.clear(handle);
    call.graceTimers.clear();

    if (call.callerDeviceId !== causedByDeviceId) {
      this.outbox.toDevice(call.callerDeviceId, { type: 'call.ended', callId: call.callId, reason: reasons.caller });
    }
    const calleeEvent: ServerEvent = { type: 'call.ended', callId: call.callId, reason: reasons.callee };
    if (call.state === 'active' && call.calleeDeviceId) {
      if (call.calleeDeviceId !== causedByDeviceId) this.outbox.toDevice(call.calleeDeviceId, calleeEvent);
    } else {
      this.outbox.toUser(call.calleeUserId, calleeEvent, { exceptDeviceId: causedByDeviceId });
      if (call.woken) this.outbox.cancelWake(snapshot(call), reasons.callee);
    }
  }
}

function snapshot(call: Call): CallSnapshot {
  return {
    callId: call.callId,
    conversationId: call.conversationId,
    media: call.media,
    callerUserId: call.callerUserId,
    callerDeviceId: call.callerDeviceId,
    calleeUserId: call.calleeUserId,
  };
}
