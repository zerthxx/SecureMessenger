import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import {
  CallRegistry,
  RECONNECT_GRACE_MS,
  RING_TIMEOUT_MS,
  type CallOutbox,
  type CallParticipant,
  type CallSnapshot,
  type CallTimers,
} from './callRegistry.js';
import type { CallEndReason, ServerEvent } from './protocol.js';

const CALL = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const OFFER = 'b2ZmZXI=';

const alice: CallParticipant = { userId: 'user-alice', deviceId: 'alice-phone' };
const bobPhone: CallParticipant = { userId: 'user-bob', deviceId: 'bob-phone' };
const bobTablet: CallParticipant = { userId: 'user-bob', deviceId: 'bob-tablet' };
const carol: CallParticipant = { userId: 'user-carol', deviceId: 'carol-phone' };

class FakeTimers implements CallTimers {
  private time = 0;
  private nextId = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  set(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.pending.set(id, { at: this.time + ms, callback });
    return id;
  }

  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  now(): number {
    return this.time;
  }

  advance(ms: number): void {
    this.time += ms;
    const due = [...this.pending].filter(([, timer]) => timer.at <= this.time).sort((a, b) => a[1].at - b[1].at);
    for (const [id, timer] of due) {
      if (!this.pending.delete(id)) continue;
      timer.callback();
    }
  }
}

class FakeOutbox implements CallOutbox {
  /** deviceId → userId of every connected device. */
  readonly connected = new Map<string, string>();
  delivered: { deviceId: string; event: ServerEvent }[] = [];
  readonly woken: { call: CallSnapshot; connected: string[] }[] = [];
  readonly wakeCancelled: { call: CallSnapshot; reason: CallEndReason }[] = [];

  connect(...participants: CallParticipant[]): void {
    for (const participant of participants) this.connected.set(participant.deviceId, participant.userId);
  }

  toDevice(deviceId: string, event: ServerEvent): boolean {
    if (!this.connected.has(deviceId)) return false;
    this.delivered.push({ deviceId, event });
    return true;
  }

  toUser(userId: string, event: ServerEvent, options: { exceptDeviceId?: string } = {}): string[] {
    const reached: string[] = [];
    for (const [deviceId, owner] of this.connected) {
      if (owner !== userId || deviceId === options.exceptDeviceId) continue;
      this.delivered.push({ deviceId, event });
      reached.push(deviceId);
    }
    return reached;
  }

  wakeCallee(call: CallSnapshot, connectedDeviceIds: string[]): void {
    this.woken.push({ call, connected: connectedDeviceIds });
  }

  cancelWake(call: CallSnapshot, reason: CallEndReason): void {
    this.wakeCancelled.push({ call, reason });
  }

  /** Events delivered since the last call, per device, then cleared. */
  take(): Record<string, ServerEvent[]> {
    const byDevice: Record<string, ServerEvent[]> = {};
    for (const { deviceId, event } of this.delivered) (byDevice[deviceId] ??= []).push(event);
    this.delivered = [];
    return byDevice;
  }
}

describe('CallRegistry', () => {
  let outbox: FakeOutbox;
  let timers: FakeTimers;
  let calls: CallRegistry;

  const invite = (payload = OFFER) =>
    calls.invite(alice, { callId: CALL, conversationId: CONVERSATION, media: 'audio', payload }, bobPhone.userId);

  beforeEach(() => {
    outbox = new FakeOutbox();
    timers = new FakeTimers();
    calls = new CallRegistry(outbox, timers);
    outbox.connect(alice, bobPhone);
  });

  test('an invite rings every connected callee device, wakes the others, and the caller hears ringing once', () => {
    outbox.connect(bobTablet);
    assert.equal(invite(), 'ringing');

    const events = outbox.take();
    for (const device of [bobPhone, bobTablet]) {
      assert.deepEqual(events[device.deviceId], [
        {
          type: 'call.incoming',
          callId: CALL,
          conversationId: CONVERSATION,
          callerUserId: alice.userId,
          media: 'audio',
          payload: OFFER,
          startedAt: new Date(0).toISOString(),
        },
      ]);
    }
    assert.equal(events[alice.deviceId], undefined);
    assert.deepEqual(outbox.woken[0]?.connected.sort(), ['bob-phone', 'bob-tablet']);

    calls.ringing(bobPhone, CALL);
    calls.ringing(bobTablet, CALL);
    assert.deepEqual(outbox.take(), { [alice.deviceId]: [{ type: 'call.ringing', callId: CALL }] });
  });

  test('the answer goes to the caller only, and the callee’s other devices stop ringing', () => {
    outbox.connect(bobTablet);
    invite();
    outbox.take();

    calls.accept(bobPhone, CALL, 'YW5zd2Vy');
    assert.deepEqual(outbox.take(), {
      [alice.deviceId]: [{ type: 'call.accepted', callId: CALL, payload: 'YW5zd2Vy' }],
      [bobTablet.deviceId]: [{ type: 'call.ended', callId: CALL, reason: 'answered_elsewhere' }],
    });
    assert.deepEqual(outbox.wakeCancelled.map((entry) => entry.reason), ['answered_elsewhere']);

    // A late second answer from another device of the same account is refused.
    calls.accept(bobTablet, CALL, 'bGF0ZQ==');
    assert.deepEqual(outbox.take(), { [bobTablet.deviceId]: [{ type: 'call.ended', callId: CALL, reason: 'answered_elsewhere' }] });
  });

  test('caller signals before the answer reach every callee device and are replayed to a device that fetches the invite', () => {
    invite();
    calls.signal(alice, CALL, 'aWNlMQ==');
    assert.deepEqual(outbox.take()[bobPhone.deviceId]?.at(-1), { type: 'call.signal', callId: CALL, payload: 'aWNlMQ==' });

    // The tablet was offline (woken by a push) and connects late.
    outbox.connect(bobTablet);
    calls.fetch(bobTablet, CALL);
    const replay = outbox.take()[bobTablet.deviceId];
    assert.equal(replay?.[0]?.type, 'call.incoming');
    assert.deepEqual(replay?.[1], { type: 'call.signal', callId: CALL, payload: 'aWNlMQ==' });

    // A callee can't trickle anything before answering.
    calls.signal(bobPhone, CALL, 'bm9wZQ==');
    assert.deepEqual(outbox.take(), {});
  });

  test('after the answer, signals flow only between the two answering devices', () => {
    outbox.connect(bobTablet);
    invite();
    calls.accept(bobPhone, CALL, 'YW5zd2Vy');
    outbox.take();

    calls.signal(alice, CALL, 'YQ==');
    calls.signal(bobPhone, CALL, 'Yg==');
    calls.signal(bobTablet, CALL, 'dGFibGV0');
    assert.deepEqual(outbox.take(), {
      [bobPhone.deviceId]: [{ type: 'call.signal', callId: CALL, payload: 'YQ==' }],
      [alice.deviceId]: [{ type: 'call.signal', callId: CALL, payload: 'Yg==' }],
    });
  });

  test('declining ends the call for the caller and the callee’s other devices', () => {
    outbox.connect(bobTablet);
    invite();
    outbox.take();

    calls.decline(bobPhone, CALL);
    assert.deepEqual(outbox.take(), {
      [alice.deviceId]: [{ type: 'call.ended', callId: CALL, reason: 'declined' }],
      [bobTablet.deviceId]: [{ type: 'call.ended', callId: CALL, reason: 'declined_elsewhere' }],
    });
    assert.equal(calls.size, 0);
  });

  test('declining as busy tells the caller the callee is busy', () => {
    invite();
    outbox.take();
    calls.decline(bobPhone, CALL, true);
    assert.deepEqual(outbox.take(), { [alice.deviceId]: [{ type: 'call.ended', callId: CALL, reason: 'busy' }] });
  });

  test('a callee already in a call is not rung, and the caller is told busy', () => {
    outbox.connect(carol);
    calls.invite(carol, { callId: '33333333-3333-4333-8333-333333333333', conversationId: CONVERSATION, media: 'video', payload: OFFER }, bobPhone.userId);
    outbox.take();

    assert.equal(invite(), 'busy');
    assert.deepEqual(outbox.take(), { [alice.deviceId]: [{ type: 'call.ended', callId: CALL, reason: 'busy' }] });
    assert.equal(calls.size, 1);
  });

  test('a caller already in a call cannot start another one, and call ids are single-use', () => {
    assert.equal(invite(), 'ringing');
    assert.equal(invite(), 'duplicate');
    assert.equal(
      calls.invite(alice, { callId: '44444444-4444-4444-8444-444444444444', conversationId: CONVERSATION, media: 'audio', payload: OFFER }, carol.userId),
      'already_in_call',
    );
  });

  test('an unanswered call times out on both sides', () => {
    invite();
    outbox.take();
    timers.advance(RING_TIMEOUT_MS - 1);
    assert.equal(calls.size, 1);
    timers.advance(1);
    assert.deepEqual(outbox.take(), {
      [alice.deviceId]: [{ type: 'call.ended', callId: CALL, reason: 'timeout' }],
      [bobPhone.deviceId]: [{ type: 'call.ended', callId: CALL, reason: 'timeout' }],
    });
    assert.deepEqual(outbox.wakeCancelled.map((entry) => entry.reason), ['timeout']);
    assert.equal(calls.size, 0);
  });

  test('the caller hanging up while ringing cancels it for every callee device', () => {
    invite();
    outbox.take();
    calls.hangup(alice, CALL);
    assert.deepEqual(outbox.take(), { [bobPhone.deviceId]: [{ type: 'call.ended', callId: CALL, reason: 'cancelled' }] });
    assert.deepEqual(outbox.wakeCancelled.map((entry) => entry.reason), ['cancelled']);
    // A ring timeout never fires for a call that already ended.
    timers.advance(RING_TIMEOUT_MS);
    assert.deepEqual(outbox.take(), {});
  });

  test('hanging up an active call tells only the other participant', () => {
    outbox.connect(bobTablet);
    invite();
    calls.accept(bobPhone, CALL, 'YW5zd2Vy');
    outbox.take();

    calls.hangup(bobPhone, CALL);
    assert.deepEqual(outbox.take(), { [alice.deviceId]: [{ type: 'call.ended', callId: CALL, reason: 'hangup' }] });
    assert.equal(calls.isUserInCall(alice.userId), false);
  });

  test('a dropped connection ends an active call only after the grace period, unless the device reconnects', () => {
    invite();
    calls.accept(bobPhone, CALL, 'YW5zd2Vy');
    outbox.take();

    calls.deviceDisconnected(alice.deviceId);
    timers.advance(RECONNECT_GRACE_MS - 1);
    calls.deviceConnected(alice.deviceId);
    timers.advance(RECONNECT_GRACE_MS);
    assert.equal(calls.size, 1);

    calls.deviceDisconnected(bobPhone.deviceId);
    timers.advance(RECONNECT_GRACE_MS);
    assert.deepEqual(outbox.take(), { [alice.deviceId]: [{ type: 'call.ended', callId: CALL, reason: 'connection_lost' }] });
    assert.equal(calls.size, 0);
  });

  test('devices outside the call cannot answer, decline, signal, or hang up', () => {
    outbox.connect(carol);
    invite();
    outbox.take();

    calls.accept(carol, CALL, 'eA==');
    calls.decline(carol, CALL);
    calls.signal(carol, CALL, 'eA==');
    calls.hangup(carol, CALL);
    calls.fetch(carol, CALL);

    const events = outbox.take();
    assert.equal(events[alice.deviceId], undefined);
    assert.equal(events[bobPhone.deviceId], undefined);
    assert.equal(calls.size, 1);
  });
});
