import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  classifyMlsError,
  coversOtherMembers,
  isFromOwnAccount,
  isPermanentWelcomeFailure,
  isStaleGenerationError,
  mayRebuildNow,
  orderForSync,
  pickWelcome,
  planRow,
  rebuildReason,
  rebuildTargets,
  rebuildWasAccepted,
  REBUILD_COOLDOWN_MS,
  sawUnusableGroup,
  signedOutMemberKeys,
  type SyncRow,
} from './groupSync.ts';

// Run with `npm test` (Node's built-in runner; no React Native involved).

const ME = 'device-me';
const PEER = 'device-peer';

function app(id: string, gen: number, sender = PEER): SyncRow & { senderDeviceId: string } {
  return { id, messageType: 'application', mlsGeneration: gen, senderDeviceId: sender };
}
function welcome(id: string, gen: number): SyncRow & { senderDeviceId: string } {
  return { id, messageType: 'welcome', mlsGeneration: gen, senderDeviceId: PEER };
}

/** Walks rows the way ChatContext's sync does, returning each row's action. */
function simulate(rows: (SyncRow & { senderDeviceId: string })[], localGeneration: number, stored: string[] = []) {
  const ordered = orderForSync(rows);
  const target = pickWelcome(ordered, localGeneration, () => false);
  let local = localGeneration;
  const actions: [string, string][] = [];
  for (const row of ordered) {
    const action = planRow(row, {
      localGeneration: local,
      targetGeneration: target?.mlsGeneration ?? 0,
      welcomeToJoinId: target?.id ?? null,
      ownDeviceId: ME,
      stored: stored.includes(row.id),
    });
    actions.push([row.id, action]);
    if (action === 'join') local = row.mlsGeneration;
    if (action === 'not_member') break;
  }
  return { actions, local };
}

describe('classifying mls-core errors', () => {
  test('each Rust variant maps to its meaning', () => {
    assert.equal(classifyMlsError(new Error('MessageFromFutureEpoch')), 'future_epoch');
    assert.equal(classifyMlsError(new Error('MessageFromPastEpoch')), 'past_epoch');
    assert.equal(classifyMlsError(new Error('OwnMessage')), 'own_message');
    assert.equal(classifyMlsError(new Error('GroupNotFound')), 'no_group');
    assert.equal(classifyMlsError(new Error('InvalidCiphertext')), 'invalid');
    assert.equal(classifyMlsError(new Error('DuplicateMessage')), 'duplicate');
    assert.equal(classifyMlsError(new Error('StorageNotInitialized')), 'transient');
    assert.equal(classifyMlsError('Network request failed'), 'transient');
  });

  test('a Welcome that is not for this device is not retried forever', () => {
    assert.equal(isPermanentWelcomeFailure(new Error('GroupOperationFailed')), true);
    assert.equal(isPermanentWelcomeFailure(new Error('InvalidInput')), true);
    assert.equal(isPermanentWelcomeFailure(new Error('Storage')), false);
  });
});

describe('syncing a conversation', () => {
  test('a device on the current group decrypts new messages', () => {
    const { actions } = simulate([app('m1', 2), app('m2', 2)], 2);
    assert.deepEqual(actions, [
      ['m1', 'decrypt'],
      ['m2', 'decrypt'],
    ]);
  });

  test('a new device joins from its Welcome and marks earlier history as unavailable, not as a failure', () => {
    const { actions, local } = simulate([app('old1', 1), app('old2', 1), welcome('w2', 2), app('new', 2)], 0);
    assert.deepEqual(actions, [
      ['old1', 'old_generation'],
      ['old2', 'old_generation'],
      ['w2', 'join'],
      ['new', 'decrypt'],
    ]);
    assert.equal(local, 2);
  });

  test('messages of the old group are read with it before switching, even if stamped after the new Welcome', () => {
    // Server order: the Welcome for gen 3 committed, then a gen-2 send that raced it.
    const { actions } = simulate([app('a', 2), welcome('w3', 3), app('raced', 2), app('b', 3)], 2);
    assert.deepEqual(actions, [
      ['a', 'decrypt'],
      ['raced', 'decrypt'],
      ['w3', 'join'],
      ['b', 'decrypt'],
    ]);
  });

  test('only the newest Welcome is joined; ones for replaced groups are skipped', () => {
    const { actions } = simulate([welcome('w1', 1), app('x', 1), welcome('w2', 2), app('y', 2)], 0);
    assert.deepEqual(actions, [
      ['w1', 'skip_welcome'],
      ['x', 'old_generation'],
      ['w2', 'join'],
      ['y', 'decrypt'],
    ]);
  });

  test('a message from a group this device is not in stops the sync (so the cursor stays) instead of being marked unreadable', () => {
    const { actions } = simulate([app('a', 1), app('b', 2), app('c', 2)], 1);
    assert.deepEqual(actions, [
      ['a', 'decrypt'],
      ['b', 'not_member'],
    ]);
  });

  test('already stored rows are never decrypted twice (MLS keys are single-use)', () => {
    const { actions } = simulate([app('a', 1), app('b', 1)], 1, ['a']);
    assert.deepEqual(actions, [
      ['a', 'already_stored'],
      ['b', 'decrypt'],
    ]);
  });

  test("this device's own message missing locally is recognised, not decrypted", () => {
    const { actions } = simulate([app('mine', 1, ME)], 1);
    assert.deepEqual(actions, [['mine', 'own_message_lost']]);
  });

  test('a Welcome already handled is not joined again', () => {
    const rows = [welcome('w2', 2)];
    assert.equal(pickWelcome(rows, 0, () => true), null);
    assert.equal(pickWelcome(rows, 2, () => false), null);
    assert.equal(pickWelcome(rows, 1, () => false)?.id, 'w2');
  });

  test("messages from this account's other devices count as outgoing", () => {
    const own = { deviceId: ME, userId: 'alice' };
    assert.equal(isFromOwnAccount({ senderDeviceId: 'other-phone', senderUserId: 'alice' }, own), true);
    assert.equal(isFromOwnAccount({ senderDeviceId: ME }, own), true);
    assert.equal(isFromOwnAccount({ senderDeviceId: PEER, senderUserId: 'bob' }, own), false);
    assert.equal(isFromOwnAccount({ senderDeviceId: PEER }, own), false);
  });
});

describe('deciding to rebuild the group', () => {
  test('only failures in the generation the device ends up on count', () => {
    // A duplicate/garbled row of generation 2, then this device joined 3 in the same sync.
    assert.equal(sawUnusableGroup({ notMember: false, failedGenerations: [2], localGeneration: 3 }), false);
    assert.equal(sawUnusableGroup({ notMember: false, failedGenerations: [3], localGeneration: 3 }), true);
    assert.equal(sawUnusableGroup({ notMember: true, failedGenerations: [], localGeneration: 3 }), true);
    assert.equal(sawUnusableGroup({ notMember: false, failedGenerations: [], localGeneration: 3 }), false);
  });

  test('each reason, in priority order', () => {
    const healthy = { serverGeneration: 2, localGeneration: 2, unreadable: false, signedOutMembers: 0 };
    assert.equal(rebuildReason(healthy), null);
    assert.equal(rebuildReason({ ...healthy, serverGeneration: 0, localGeneration: 0 }), 'no_group_yet');
    assert.equal(rebuildReason({ ...healthy, localGeneration: 1 }), 'not_in_current_group');
    assert.equal(rebuildReason({ ...healthy, localGeneration: 0 }), 'not_in_current_group');
    assert.equal(rebuildReason({ ...healthy, unreadable: true }), 'unreadable');
    assert.equal(rebuildReason({ ...healthy, signedOutMembers: 1 }), 'signed_out_member');
  });

  test('automatic rebuilds are rate-limited per conversation, user actions are not', () => {
    const now = 1_000_000;
    assert.equal(mayRebuildNow(undefined, now, false), true);
    assert.equal(mayRebuildNow(now - 1000, now, false), false);
    assert.equal(mayRebuildNow(now - REBUILD_COOLDOWN_MS, now, false), true);
    assert.equal(mayRebuildNow(now - 1000, now, true), true);
  });

  test('a signed-out device still in the group is detected', () => {
    assert.deepEqual(signedOutMemberKeys(['me', 'bob-phone', 'bob-old-phone'], ['me', 'bob-phone', 'bob-tablet']), ['bob-old-phone']);
    assert.deepEqual(signedOutMemberKeys(['me', 'bob'], ['me', 'bob', 'bob-new']), []);
  });

  test('the rebuild adds everyone but this install, including an older server row of it', () => {
    const devices = [
      { deviceId: ME, userId: 'alice', credentialPublicKey: 'k-me' },
      { deviceId: 'me-previous-login', userId: 'alice', credentialPublicKey: 'k-me' },
      { deviceId: 'alice-tablet', userId: 'alice', credentialPublicKey: 'k-tab' },
      { deviceId: PEER, userId: 'bob', credentialPublicKey: 'k-bob' },
    ];
    assert.deepEqual(
      rebuildTargets(devices, { deviceId: ME, credentialPublicKey: 'k-me' }).map((d) => d.deviceId),
      ['alice-tablet', PEER],
    );
  });

  test('a rebuild that would leave the other person out is refused', () => {
    assert.equal(coversOtherMembers(['bob'], ['alice', 'bob'], 'alice'), true);
    assert.equal(coversOtherMembers(['alice'], ['alice', 'bob'], 'alice'), false);
    assert.equal(coversOtherMembers([], ['alice', 'bob'], 'alice'), false);
  });

  test("a retried rebuild recognises its own earlier attempt; someone else's win is not mistaken for ours", () => {
    assert.equal(rebuildWasAccepted({ ok: true, generation: 3 }, 2), true);
    assert.equal(rebuildWasAccepted({ ok: false, generation: 3, builtByThisDevice: true }, 2), true);
    assert.equal(rebuildWasAccepted({ ok: false, generation: 3, builtByThisDevice: false }, 2), false);
    assert.equal(rebuildWasAccepted({ ok: false, generation: 4, builtByThisDevice: true }, 2), false);
  });

  test('a stale-generation refusal from the server is recognised', () => {
    assert.equal(isStaleGenerationError(new Error('STALE_GROUP_GENERATION')), true);
    assert.equal(isStaleGenerationError(new Error('Too many attempts')), false);
  });
});
