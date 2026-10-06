import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { stateFromResult, UsernameAvailabilityChecker, type AvailabilityState, type CheckResult } from './usernameAvailability.ts';

/** Timers that only fire when told to. */
function manualTimers() {
  let next = 0;
  const pending = new Map<number, () => void>();
  return {
    set: (fn: () => void) => {
      const id = ++next;
      pending.set(id, fn);
      return id;
    },
    clear: (id: unknown) => void pending.delete(id as number),
    fireAll: () => {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

/** A server whose answers are released one by one, in any order. */
function controllableServer() {
  const calls: { username: string; resolve: (r: CheckResult) => void; reject: (e: Error) => void }[] = [];
  return {
    check: (username: string) =>
      new Promise<CheckResult>((resolve, reject) => {
        calls.push({ username, resolve, reject });
      }),
    calls,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup() {
  const timers = manualTimers();
  const server = controllableServer();
  const states: AvailabilityState[] = [];
  const checker = new UsernameAvailabilityChecker(server.check, (s) => states.push(s), timers, 500);
  return { timers, server, states, checker, last: () => states[states.length - 1] };
}

describe('server answer → state', () => {
  test('known answers map to their states', () => {
    assert.equal(stateFromResult({ available: true }), 'available');
    assert.equal(stateFromResult({ available: false, reason: 'taken' }), 'taken');
    assert.equal(stateFromResult({ available: false, reason: 'reserved' }), 'reserved');
    assert.equal(stateFromResult({ available: false, reason: 'invalid' }), 'invalid');
  });

  test('an unknown or missing reason is never shown as available (and never an unknown state)', () => {
    assert.equal(stateFromResult({ available: false, reason: 'too_long' }), 'invalid');
    assert.equal(stateFromResult({ available: false }), 'invalid');
  });
});

describe('UsernameAvailabilityChecker', () => {
  test('empty and too-short names are decided locally, without asking the server', () => {
    const { checker, server, states } = setup();
    checker.update('');
    checker.update('ab');
    assert.deepEqual(states, ['idle', 'invalid']);
    assert.equal(server.calls.length, 0);
  });

  test('checks after the pause in typing, showing loading then the answer', async () => {
    const { checker, server, timers, last } = setup();
    checker.update('alice');
    assert.equal(last(), 'checking');
    assert.equal(server.calls.length, 0);
    timers.fireAll();
    assert.equal(server.calls.length, 1);
    server.calls[0]!.resolve({ available: true });
    await flush();
    assert.equal(last(), 'available');
  });

  test('only the last name typed is checked', () => {
    const { checker, server, timers } = setup();
    checker.update('ali');
    checker.update('alic');
    checker.update('alice');
    timers.fireAll();
    assert.deepEqual(
      server.calls.map((c) => c.username),
      ['alice'],
    );
  });

  test("a slow answer for an older name never overwrites the current name's answer", async () => {
    const { checker, server, timers, last } = setup();
    checker.update('alice');
    timers.fireAll();
    checker.update('alice_2');
    timers.fireAll();
    // The newer name is taken; the older one's "available" arrives last.
    server.calls[1]!.resolve({ available: false, reason: 'taken' });
    await flush();
    server.calls[0]!.resolve({ available: true });
    await flush();
    assert.equal(last(), 'taken');
  });

  test('coming back to the screen re-checks: a name taken meanwhile no longer shows "Available"', async () => {
    const { checker, server, timers, last } = setup();
    checker.update('alice');
    timers.fireAll();
    server.calls[0]!.resolve({ available: true });
    await flush();
    assert.equal(last(), 'available');

    checker.recheck();
    assert.equal(last(), 'checking', 'never shows the old answer while re-checking');
    timers.fireAll();
    server.calls[1]!.resolve({ available: false, reason: 'taken' });
    await flush();
    assert.equal(last(), 'taken');
  });

  test('an error can be retried without editing the name', async () => {
    const { checker, server, timers, last } = setup();
    checker.update('alice');
    timers.fireAll();
    server.calls[0]!.reject(new Error('offline'));
    await flush();
    assert.equal(last(), 'error');

    checker.recheck();
    timers.fireAll();
    server.calls[1]!.resolve({ available: true });
    await flush();
    assert.equal(last(), 'available');
  });

  test('a second check of the same name supersedes the first', async () => {
    const { checker, server, timers, last } = setup();
    checker.update('alice');
    timers.fireAll();
    checker.recheck();
    timers.fireAll();
    server.calls[1]!.resolve({ available: false, reason: 'taken' });
    await flush();
    server.calls[0]!.resolve({ available: true });
    await flush();
    assert.equal(last(), 'taken');
  });

  test('nothing is reported after the screen goes away', async () => {
    const { checker, server, timers, states } = setup();
    checker.update('alice');
    timers.fireAll();
    const before = states.length;
    checker.dispose();
    server.calls[0]!.resolve({ available: true });
    await flush();
    checker.update('bob_1');
    assert.equal(states.length, before);
    assert.equal(timers.pendingCount, 0);
  });
});
