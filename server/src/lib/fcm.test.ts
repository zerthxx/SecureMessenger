import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

import { exportPKCS8, generateKeyPair } from 'jose';

import { buildNewMessagePush, classifyFcmResponse, createFcmClient, parseServiceAccount, type FcmServiceAccount } from './fcm.js';

describe('parseServiceAccount', () => {
  test('reads project_id, client_email and private_key', () => {
    const account = parseServiceAccount(
      JSON.stringify({ project_id: 'demo', client_email: 'push@demo.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' }),
    );
    assert.equal(account.projectId, 'demo');
    assert.equal(account.clientEmail, 'push@demo.iam.gserviceaccount.com');
  });

  test('rejects invalid JSON and incomplete keys', () => {
    assert.throws(() => parseServiceAccount('{not json'), /not valid JSON/);
    assert.throws(() => parseServiceAccount(JSON.stringify({ project_id: 'demo' })), /service account key/);
  });
});

describe('buildNewMessagePush', () => {
  test('is generic, targets the messages channel, and carries the conversation id', () => {
    const push = buildNewMessagePush('device-token', 'conv-1');
    assert.equal(push.message.token, 'device-token');
    assert.deepEqual(push.message.notification, { title: 'SecureMessenger', body: 'New message' });
    assert.deepEqual(push.message.data, { type: 'new_message', conversationId: 'conv-1' });
    assert.equal(push.message.android.notification.channel_id, 'messages');
  });
});

describe('classifyFcmResponse', () => {
  test('success', () => {
    assert.equal(classifyFcmResponse(200, null), 'sent');
  });

  test('dead tokens', () => {
    assert.equal(
      classifyFcmResponse(404, { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }),
      'invalid_token',
    );
    assert.equal(classifyFcmResponse(400, { error: { status: 'INVALID_ARGUMENT' } }), 'invalid_token');
    assert.equal(classifyFcmResponse(403, { error: { details: [{ errorCode: 'SENDER_ID_MISMATCH' }] } }), 'invalid_token');
  });

  test('credentials, throttling, and everything else', () => {
    assert.equal(classifyFcmResponse(401, { error: { status: 'UNAUTHENTICATED' } }), 'auth_error');
    assert.equal(classifyFcmResponse(429, { error: { status: 'RESOURCE_EXHAUSTED' } }), 'retryable');
    assert.equal(classifyFcmResponse(503, null), 'retryable');
    assert.equal(classifyFcmResponse(418, null), 'failed');
  });
});

describe('createFcmClient', () => {
  let account: FcmServiceAccount;

  before(async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    account = { projectId: 'demo-project', clientEmail: 'push@demo.iam.gserviceaccount.com', privateKey: await exportPKCS8(privateKey) };
  });

  test('exchanges a signed assertion for an access token once, then sends with it', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'access-1', expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ name: 'projects/demo-project/messages/1' }), { status: 200 });
    }) as typeof fetch;

    const client = createFcmClient(account, fakeFetch);
    assert.equal(await client.send(buildNewMessagePush('t1', 'c1')), 'sent');
    assert.equal(await client.send(buildNewMessagePush('t2', 'c1')), 'sent');

    const tokenCalls = calls.filter((c) => c.url.startsWith('https://oauth2.googleapis.com/token'));
    const sendCalls = calls.filter((c) => c.url === 'https://fcm.googleapis.com/v1/projects/demo-project/messages:send');
    assert.equal(tokenCalls.length, 1);
    assert.equal(sendCalls.length, 2);
    assert.match(String(tokenCalls[0]!.init?.body), /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=/);
    assert.equal((sendCalls[0]!.init?.headers as Record<string, string>).authorization, 'Bearer access-1');
  });

  test('a 401 from FCM discards the cached access token', async () => {
    let tokenRequests = 0;
    let sends = 0;
    const fakeFetch = (async (url: string | URL | Request) => {
      if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
        tokenRequests += 1;
        return new Response(JSON.stringify({ access_token: `access-${tokenRequests}`, expires_in: 3600 }), { status: 200 });
      }
      sends += 1;
      return sends === 1
        ? new Response(JSON.stringify({ error: { status: 'UNAUTHENTICATED' } }), { status: 401 })
        : new Response('{}', { status: 200 });
    }) as typeof fetch;

    const client = createFcmClient(account, fakeFetch);
    assert.equal(await client.send(buildNewMessagePush('t', 'c')), 'auth_error');
    assert.equal(await client.send(buildNewMessagePush('t', 'c')), 'sent');
    assert.equal(tokenRequests, 2);
  });
});
