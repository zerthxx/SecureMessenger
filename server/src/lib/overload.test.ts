import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { TRPCError } from '@trpc/server';

import { retryAfterSeconds, SERVER_BUSY_MESSAGE, shedIfOverloaded, shouldShed } from './overload.js';

describe('database pool load shedding', () => {
  test('sheds only once more requests wait for a connection than the threshold allows', () => {
    assert.equal(shouldShed({ waiting: 0, max: 10 }, 20), false);
    assert.equal(shouldShed({ waiting: 20, max: 10 }, 20), false);
    assert.equal(shouldShed({ waiting: 21, max: 10 }, 20), true);
  });

  test('a threshold of 0 disables shedding whatever the queue', () => {
    assert.equal(shouldShed({ waiting: 5000, max: 10 }, 0), false);
    assert.equal(retryAfterSeconds({ waiting: 5000, max: 10 }, 0), 5);
  });

  test('Retry-After grows with the queue, between 5 and 30 seconds', () => {
    assert.equal(retryAfterSeconds({ waiting: 21, max: 10 }, 20), 5);
    assert.equal(retryAfterSeconds({ waiting: 60, max: 10 }, 20), 15);
    assert.equal(retryAfterSeconds({ waiting: 100, max: 10 }, 20), 25);
    assert.equal(retryAfterSeconds({ waiting: 1000, max: 10 }, 20), 30);
  });

  test('an overloaded pool refuses the call with TOO_MANY_REQUESTS and a Retry-After header, before any database work', () => {
    let header: number | null = null;
    let logged: unknown = null;
    assert.throws(
      () =>
        shedIfOverloaded(
          () => ({ waiting: 60, max: 10 }),
          20,
          (seconds) => {
            header = seconds;
          },
          (pressure, retryAfter) => {
            logged = { pressure, retryAfter };
          },
        ),
      (err: unknown) => err instanceof TRPCError && err.code === 'TOO_MANY_REQUESTS' && err.message === SERVER_BUSY_MESSAGE,
    );
    assert.equal(header, 15);
    assert.deepEqual(logged, { pressure: { waiting: 60, max: 10 }, retryAfter: 15 });
  });

  test('a healthy pool lets the call through and sets no header', () => {
    let header: number | null = null;
    shedIfOverloaded(
      () => ({ waiting: 3, max: 10 }),
      20,
      (seconds) => {
        header = seconds;
      },
    );
    assert.equal(header, null);
  });
});
