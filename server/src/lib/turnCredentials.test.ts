import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createCloudflareTurnProvider, parseCloudflareIceServers } from './turnCredentials.js';

const RESPONSE = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:53?transport=udp',
        'turns:turn.cloudflare.com:443?transport=tcp',
      ],
      username: 'generated-user',
      credential: 'generated-secret',
    },
  ],
};

describe('parseCloudflareIceServers', () => {
  test('keeps STUN/TURN URLs with their credentials and drops port 53', () => {
    assert.deepEqual(parseCloudflareIceServers(RESPONSE), [
      { urls: ['stun:stun.cloudflare.com:3478'] },
      {
        urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
        username: 'generated-user',
        credential: 'generated-secret',
      },
    ]);
  });

  test('rejects responses without a server list and skips unusable entries', () => {
    assert.throws(() => parseCloudflareIceServers({}), /no iceServers/);
    assert.deepEqual(parseCloudflareIceServers({ iceServers: [{ urls: ['http://example.com'] }, null, { urls: 'stun:a.example:3478' }] }), [
      { urls: ['stun:a.example:3478'] },
    ]);
  });
});

describe('createCloudflareTurnProvider', () => {
  test('mints credentials with the API token and TTL, and reports when they expire', async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify(RESPONSE), { status: 201 });
    }) as typeof fetch;

    const provider = createCloudflareTurnProvider({ keyId: 'key/1', apiToken: 'secret-token', ttlSeconds: 600, fetchImpl, now: () => 0 });
    const config = await provider.getIceServers();

    assert.equal(requests[0]?.url, 'https://rtc.live.cloudflare.com/v1/turn/keys/key%2F1/credentials/generate-ice-servers');
    assert.equal(requests[0]?.init?.method, 'POST');
    assert.equal((requests[0]?.init?.headers as Record<string, string>).authorization, 'Bearer secret-token');
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), { ttl: 600 });
    assert.equal(config.relay, true);
    assert.equal(config.expiresAt, new Date(600_000).toISOString());
    assert.equal(config.iceServers.length, 2);
  });

  test('fails on HTTP errors and on responses without a relay', async () => {
    const failing = createCloudflareTurnProvider({
      keyId: 'k',
      apiToken: 't',
      fetchImpl: (async () => new Response('nope', { status: 401 })) as typeof fetch,
    });
    await assert.rejects(failing.getIceServers(), /HTTP 401/);

    const stunOnly = createCloudflareTurnProvider({
      keyId: 'k',
      apiToken: 't',
      fetchImpl: (async () => new Response(JSON.stringify({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] }), { status: 201 })) as typeof fetch,
    });
    await assert.rejects(stunOnly.getIceServers(), /did not include a relay/);
  });
});
