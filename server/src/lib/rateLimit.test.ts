import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { __resetRateLimitsForTest, checkRateLimit, ipBucket, RateLimitExceededError } from './rateLimit.js';

describe('ipBucket', () => {
  test('an IPv4 address is its own bucket', () => {
    assert.equal(ipBucket('203.0.113.7'), '203.0.113.7');
  });

  test('an IPv4-mapped IPv6 address counts as the IPv4 address', () => {
    assert.equal(ipBucket('::ffff:203.0.113.7'), '203.0.113.7');
  });

  test('every address in one IPv6 /64 shares a bucket, whatever its spelling', () => {
    const bucket = ipBucket('2001:db8:85a3:12::1');
    assert.equal(bucket, '2001:db8:85a3:12::/64');
    assert.equal(ipBucket('2001:0DB8:85A3:0012:ffff:1:2:3'), bucket);
    assert.equal(ipBucket('2001:db8:85a3:12:abcd::'), bucket);
    assert.equal(ipBucket('2001:db8:85a3:12::1%eth0'), bucket);
  });

  test('different /64s are different buckets', () => {
    assert.notEqual(ipBucket('2001:db8:85a3:12::1'), ipBucket('2001:db8:85a3:13::1'));
    assert.equal(ipBucket('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(ipBucket('::1'), '0:0:0:0::/64');
  });

  test('something that is not an address is left as is', () => {
    assert.equal(ipBucket('unknown'), 'unknown');
  });
});

describe('checkRateLimit when the tracked-key cap is reached', () => {
  beforeEach(() => __resetRateLimitsForTest());

  test("a flood of throwaway keys doesn't reset a live per-account limit", () => {
    for (let i = 0; i < 10; i++) checkRateLimit('login:user:victim', 10, 15 * 60 * 1000);
    assert.throws(() => checkRateLimit('login:user:victim', 10, 15 * 60 * 1000), RateLimitExceededError);

    // Short-lived throwaway buckets: expired by the time the cap is hit.
    const realNow = Date.now;
    try {
      for (let i = 0; i < 50_000; i++) checkRateLimit(`login:ip:flood-${i}`, 10, 1);
      const later = realNow() + 10;
      Date.now = () => later;
      checkRateLimit('login:ip:one-more', 10, 15 * 60 * 1000);
      assert.throws(() => checkRateLimit('login:user:victim', 10, 15 * 60 * 1000), RateLimitExceededError);
    } finally {
      Date.now = realNow;
    }
  });

  test('with only live buckets, the oldest are dropped and the newest kept', () => {
    for (let i = 0; i < 50_000; i++) checkRateLimit(`k:${i}`, 1, 60_000);
    checkRateLimit('k:new', 1, 60_000);
    // The newest (and a recent one) are still counted…
    assert.throws(() => checkRateLimit('k:new', 1, 60_000), RateLimitExceededError);
    assert.throws(() => checkRateLimit('k:49999', 1, 60_000), RateLimitExceededError);
    // …the oldest were evicted, so they start a fresh window.
    assert.doesNotThrow(() => checkRateLimit('k:0', 1, 60_000));
  });
});
