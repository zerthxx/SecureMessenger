import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createReplayCache } from './registrationReplay.js';

describe('registration replay cache', () => {
  test('a repeat of a finished sign-up gets the original outcome without running again', async () => {
    const cache = createReplayCache<string>(60_000);
    let runs = 0;
    const task = async () => `account-${++runs}`;
    assert.equal(await cache.run('id:alice', task).promise, 'account-1');
    const again = cache.run('id:alice', task);
    assert.equal(again.replayed, true);
    assert.equal(await again.promise, 'account-1');
    assert.equal(runs, 1);
  });

  test('a repeat arriving while the first is still running waits for the same outcome', async () => {
    const cache = createReplayCache<string>(60_000);
    let release!: (value: string) => void;
    let runs = 0;
    const task = () => {
      runs++;
      return new Promise<string>((resolve) => (release = resolve));
    };
    const first = cache.run('id:alice', task);
    const second = cache.run('id:alice', task);
    release('account');
    assert.deepEqual(await Promise.all([first.promise, second.promise]), ['account', 'account']);
    assert.equal(runs, 1);
    assert.equal(second.replayed, true);
  });

  test('a failed sign-up is forgotten, so retrying it really retries', async () => {
    const cache = createReplayCache<string>(60_000);
    await assert.rejects(cache.run('id:alice', async () => Promise.reject(new Error('db down'))).promise);
    const retry = cache.run('id:alice', async () => 'account');
    assert.equal(retry.replayed, false);
    assert.equal(await retry.promise, 'account');
  });

  test('different keys never share an outcome', async () => {
    const cache = createReplayCache<string>(60_000);
    await cache.run('id:alice', async () => 'alice').promise;
    const other = cache.run('id:bob', async () => 'bob');
    assert.equal(other.replayed, false);
    assert.equal(await other.promise, 'bob');
  });

  test('after the window a repeat runs again', async () => {
    let clock = 0;
    const cache = createReplayCache<string>(1_000, () => clock);
    await cache.run('id:alice', async () => 'first').promise;
    clock = 1_001;
    const later = cache.run('id:alice', async () => 'second');
    assert.equal(later.replayed, false);
    assert.equal(await later.promise, 'second');
  });
});
