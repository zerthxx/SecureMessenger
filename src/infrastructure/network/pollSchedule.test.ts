import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { jitter, nextPollDelayMs } from './pollSchedule.ts';

const noJitter = () => 0.5; // jitter() maps 0.5 to exactly 1.0×

describe('background poll cadence', () => {
  test('with the socket up it polls at the slow cadence whatever happened before', () => {
    for (const quietPolls of [0, 1, 7, 100]) {
      assert.equal(nextPollDelayMs({ realtimeOnline: true, quietPolls, baseMs: 3000, onlineMs: 30000, random: noJitter }), 30000);
    }
  });

  test('with the socket down it starts fast and doubles each quiet poll, capped at the online cadence', () => {
    const delays = [0, 1, 2, 3, 4, 5, 50].map((quietPolls) =>
      nextPollDelayMs({ realtimeOnline: false, quietPolls, baseMs: 3000, onlineMs: 30000, random: noJitter }),
    );
    assert.deepEqual(delays, [3000, 6000, 12000, 24000, 30000, 30000, 30000]);
  });

  test('the chat list, with a slower base, reaches the cap in fewer steps', () => {
    const delays = [0, 1, 2, 3].map((quietPolls) =>
      nextPollDelayMs({ realtimeOnline: false, quietPolls, baseMs: 6000, onlineMs: 30000, random: noJitter }),
    );
    assert.deepEqual(delays, [6000, 12000, 24000, 30000]);
  });

  test('jitter spreads a delay by at most a quarter either way, never beyond', () => {
    assert.equal(jitter(1000, () => 0), 750);
    assert.equal(jitter(1000, () => 0.999999), 1250);
    for (let i = 0; i < 200; i++) {
      const d = nextPollDelayMs({ realtimeOnline: false, quietPolls: 9, baseMs: 3000, onlineMs: 30000 });
      assert.ok(d >= 22500 && d <= 37500, `jittered cap out of range: ${d}`);
    }
  });

  test('a fleet of idle offline phones settles to the online cadence within about a minute', () => {
    // Sum of the first offline waits: the storm is confined to the first ~45 s.
    let elapsed = 0;
    let quietPolls = 0;
    while (elapsed < 60000) {
      elapsed += nextPollDelayMs({ realtimeOnline: false, quietPolls, baseMs: 3000, onlineMs: 30000, random: noJitter });
      quietPolls += 1;
    }
    // 3 + 6 + 12 + 24 = 45 s after four polls; the fifth is already at the cap.
    assert.equal(quietPolls, 5);
  });
});
