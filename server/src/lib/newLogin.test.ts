import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { RealtimeHub, type RealtimeSocket } from '../realtime/hub.js';
import { buildNewLoginPush, SECURITY_CHANNEL_ID } from './fcm.js';
import { announceNewLogin, newLoginPushText, type NewLoginNotice } from './newLogin.js';

function fakeSocket() {
  const sent: string[] = [];
  const socket: RealtimeSocket = {
    readyState: 1,
    send: (data) => {
      sent.push(data);
    },
    close: () => {},
  };
  return { socket, sent };
}

const NOTICE: NewLoginNotice = {
  sessionId: 'alice-new',
  deviceName: 'Pixel 9',
  platform: 'android',
  location: null,
  at: '2026-09-14T12:00:00.000Z',
};

describe('new login notification', () => {
  test("the account's connected devices get a realtime alert, the others a push, and the new session neither", async () => {
    const hub = new RealtimeHub();
    const phone = fakeSocket();
    const newDevice = fakeSocket();
    const bob = fakeSocket();
    hub.add({ userId: 'alice', deviceId: 'alice-phone', socket: phone.socket });
    hub.add({ userId: 'alice', deviceId: 'alice-new', socket: newDevice.socket });
    hub.add({ userId: 'bob', deviceId: 'bob-phone', socket: bob.socket });

    const pushExclusions: string[][] = [];
    await announceNewLogin({
      userId: 'alice',
      notice: NOTICE,
      toUser: (userId, event, options) => hub.toUser(userId, event, options),
      push: async (excludeDeviceIds) => {
        pushExclusions.push(excludeDeviceIds);
      },
    });

    assert.deepEqual(phone.sent.map((data) => JSON.parse(data) as unknown), [{ type: 'security.new_login', ...NOTICE }]);
    assert.deepEqual(newDevice.sent, []);
    assert.deepEqual(bob.sent, []);
    // Pushes skip the new session and every device already alerted in-app.
    assert.deepEqual(pushExclusions, [['alice-new', 'alice-phone']]);
  });

  test('the alert names the device, and the location when known', () => {
    assert.deepEqual(newLoginPushText(NOTICE), {
      title: 'New login detected',
      body: 'Pixel 9 signed in to your account. Tap to review your devices.',
    });
    assert.match(newLoginPushText({ ...NOTICE, location: 'Berlin, Germany' }).body, /Pixel 9 near Berlin, Germany/);
  });

  test('the push opens Devices on the security channel and carries no credential', () => {
    const push = buildNewLoginPush('device-token', newLoginPushText(NOTICE), NOTICE.sessionId);
    assert.deepEqual(push.message.data, { type: 'new_login', sessionId: 'alice-new' });
    assert.equal(push.message.android.notification.channel_id, SECURITY_CHANNEL_ID);
    assert.equal(push.message.notification.title, 'New login detected');
  });
});
