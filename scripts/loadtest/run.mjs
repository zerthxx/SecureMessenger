#!/usr/bin/env node
// Load / failure harness for the SecureMessenger API. LOCAL OR DEDICATED
// TEST SERVERS ONLY: it registers throwaway accounts and sends random
// ciphertext. It refuses hosts that look like production.
//
// Phases:
//   1. registers N users, each with its own X-Forwarded-For address so the
//      server's per-IP limits see N clients (start the server with
//      TRUST_PROXY=loopback for that to take effect);
//   2. pairs them, creates a conversation per pair and establishes
//      generation 1 with an opaque Welcome (the server never inspects MLS
//      bytes, so random bytes exercise exactly the same server path);
//   3. opens one authenticated WebSocket per user and keeps it alive with
//      the app's 20 s ping;
//   4. for `duration` seconds every user sends `rate` messages per minute,
//      each a unique random ciphertext; the receiver waits for the realtime
//      "conversation.updated" hint and then fetches, like the app does;
//   5. reports send latency (p50/p95/p99), hint latency, errors, timeouts,
//      socket drops/reconnects, and what each receiver fetched: duplicates,
//      ordering, missing rows.
//
// Usage:
//   node scripts/loadtest/run.mjs --base http://localhost:4100 --users 50 --duration 60 --rate 6
// Options: --timeout <ms> (request timeout, default 20000), --fetch-every <n>
//   (receivers fetch after every n-th hint instead of only at the end, default 0 = end only).
// Results: scripts/loadtest/results/<timestamp>.json (and a one-line summary on stdout).
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const WebSocket = require('../../server/node_modules/ws');

// One keep-alive socket per virtual user, like a phone. Opening a fresh TCP
// connection per request (what global fetch does under concurrency) made the
// client-observed tail on Windows loopback 10-100x the server-side time
// because of SYN retransmits, which says nothing about the server.
const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg('base', 'http://localhost:4100');
const USERS = Number(arg('users', 20));
const DURATION = Number(arg('duration', 30));
const RATE = Number(arg('rate', 6)); // messages per user per minute
const TIMEOUT_MS = Number(arg('timeout', 20000));
const FETCH_EVERY = Number(arg('fetch-every', 0));
// --sockets-only: register, open the sockets, hold them idle for `duration`
// seconds and exit. Sample the server's RSS during the hold to get memory
// per idle connection.
const SOCKETS_ONLY = process.argv.includes('--sockets-only');
if (/railway|supabase|prod|\.app\b|https:/i.test(BASE)) throw new Error(`refusing to load-test a production-looking host: ${BASE}`);

const pct = (arr, p) => {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const countError = (bucket, err) => {
  const k = (err?.message ?? String(err)).slice(0, 80);
  bucket[k] = (bucket[k] ?? 0) + 1;
};

async function call(user, path, input, method = 'POST') {
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': user.ip };
  if (user.token) headers.authorization = `Bearer ${user.token}`;
  const url =
    method === 'GET'
      ? `${BASE}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`
      : `${BASE}/trpc/${path}`;
  const body = method === 'GET' ? undefined : JSON.stringify(input ?? {});
  const { status, text } = await new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent, timeout: TIMEOUT_MS }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('request timeout'), { name: 'AbortError' })));
    req.on('error', reject);
    req.end(body);
  });
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {}
  if (status < 200 || status >= 300 || json.error) {
    throw Object.assign(new Error(`${status} ${json.error?.message ?? ''}`.trim()), { status });
  }
  return json.result.data;
}

const stats = {
  startedAt: new Date().toISOString(),
  base: BASE,
  users: USERS,
  duration: DURATION,
  rate: RATE,
  registered: 0,
  registerErrors: {},
  setupErrors: {},
  conversations: 0,
  sockets: { opened: 0, closed: 0, reconnects: 0, errors: 0 },
  sends: { ok: 0, failed: 0, timeouts: 0, errors: {}, latencies: [] },
  hints: { expected: 0, received: 0, latencies: [] },
  fetch: { calls: 0, errors: {}, rows: 0, duplicates: 0, outOfOrder: 0, missing: 0, latencies: [] },
};

// Setup phases run SETUP_CONCURRENCY users at a time (a sign-up wave, not
// the steady state under test); the figures that matter come from phase 4.
const SETUP_CONCURRENCY = Number(arg('setup-concurrency', 10));
async function inBatches(items, worker) {
  for (let i = 0; i < items.length; i += SETUP_CONCURRENCY) {
    await Promise.all(items.slice(i, i + SETUP_CONCURRENCY).map(worker));
  }
}

// 1. register
const users = [];
const stamp = Date.now().toString(36);
const t0reg = performance.now();
await inBatches(
  Array.from({ length: USERS }, (_, i) => i),
  async (i) => {
    const user = {
      ip: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`,
      username: `lt${stamp}${i.toString(36)}`.slice(0, 20),
    };
    try {
      const r = await call(user, 'auth.register', {
        username: user.username,
        displayName: 'Load Test',
        password: 'Load-Test-2026-x',
        device: { name: 'loadtest', platform: 'android', model: 'loadtest', osVersion: '0', appVersion: '0.0.0' },
        registrationId: randomUUID(),
      });
      user.token = r.session.accessToken;
      user.id = r.user.id;
      user.deviceId = r.device.id;
      users[i] = user;
      stats.registered++;
    } catch (err) {
      countError(stats.registerErrors, err);
    }
  },
);
const registered = users.filter(Boolean);
users.length = 0;
users.push(...registered);
stats.registerSeconds = Math.round(performance.now() - t0reg) / 1000;
console.log(`registered ${stats.registered}/${USERS} in ${stats.registerSeconds}s`, JSON.stringify(stats.registerErrors));

// 2. pair + conversation + generation 1
const pairs = [];
const t0setup = performance.now();
const pairIndexes = [];
for (let i = 0; !SOCKETS_ONLY && i + 1 < users.length; i += 2) pairIndexes.push(i);
await inBatches(pairIndexes, async (i) => {
  const [a, b] = [users[i], users[i + 1]];
  try {
    for (const u of [a, b]) {
      await call(u, 'e2ee.registerIdentityKey', { publicKey: randomBytes(32).toString('base64') });
      await call(u, 'e2ee.registerDeviceCredential', {
        credentialPublicKey: randomBytes(32).toString('base64'),
        crossSignature: randomBytes(64).toString('base64'),
      });
    }
    const { conversationId } = await call(a, 'e2ee.createConversation', { otherUserId: b.id });
    const reset = await call(a, 'e2ee.resetGroup', {
      conversationId,
      expectedGeneration: 0,
      welcome: randomBytes(600).toString('base64'),
      recipientDeviceIds: [b.deviceId],
    });
    if (!reset.ok) throw new Error(`resetGroup not ok: generation ${reset.generation}`);
    const pair = { a, b, conversationId, expected: new Map() };
    a.pair = pair;
    b.pair = pair;
    pairs.push(pair);
    stats.conversations++;
  } catch (err) {
    countError(stats.setupErrors, err);
  }
});
stats.setupSeconds = Math.round(performance.now() - t0setup) / 1000;
console.log(`conversations ${stats.conversations} in ${stats.setupSeconds}s`, JSON.stringify(stats.setupErrors));

// 3. sockets
let stopped = false;
const pendingHints = new Map(); // `${conversationId}:${deviceId}` -> [sentAt, ...]
async function fetchAndCheck(reader, pair) {
  const t0 = performance.now();
  stats.fetch.calls++;
  try {
    const rows = await call(reader, 'e2ee.fetchMessages', { conversationId: pair.conversationId, page: { limit: 500 } }, 'GET');
    stats.fetch.latencies.push(performance.now() - t0);
    return rows;
  } catch (err) {
    countError(stats.fetch.errors, err);
    return null;
  }
}
function connect(user) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/realtime`, {
    headers: { authorization: `Bearer ${user.token}`, 'x-forwarded-for': user.ip },
  });
  ws.on('open', () => {
    stats.sockets.opened++;
  });
  ws.on('message', (data) => {
    let ev;
    try {
      ev = JSON.parse(String(data));
    } catch {
      return;
    }
    if (ev.type !== 'conversation.updated') return;
    const key = `${ev.conversationId}:${user.deviceId}`;
    const queue = pendingHints.get(key);
    const sentAt = queue?.shift();
    if (sentAt !== undefined) {
      stats.hints.received++;
      stats.hints.latencies.push(performance.now() - sentAt);
    }
    user.hintCount = (user.hintCount ?? 0) + 1;
    if (FETCH_EVERY > 0 && user.pair && user.hintCount % FETCH_EVERY === 0) void fetchAndCheck(user, user.pair);
  });
  ws.on('close', () => {
    stats.sockets.closed++;
    if (!stopped) {
      stats.sockets.reconnects++;
      setTimeout(() => connect(user), 1000);
    }
  });
  ws.on('error', () => {
    stats.sockets.errors++;
  });
  user.ws = ws;
  clearInterval(user.ping);
  user.ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
  }, 20000);
}
for (const u of users) connect(u);
await sleep(Math.min(5000, 500 + users.length * 10));
stats.sockets.openAfterConnect = users.filter((u) => u.ws?.readyState === WebSocket.OPEN).length;
console.log(`sockets open ${stats.sockets.openAfterConnect}/${users.length}`);
if (SOCKETS_ONLY) {
  // Drop the HTTP keep-alive sockets so only the WebSockets stay open and
  // the server's memory delta is attributable to them.
  agent.destroy();
  console.log(`holding ${stats.sockets.openAfterConnect} idle sockets for ${DURATION}s`);
  await sleep(DURATION * 1000);
  stats.sockets.openAtEnd = users.filter((u) => u.ws?.readyState === WebSocket.OPEN).length;
  stopped = true;
  for (const u of users) {
    clearInterval(u.ping);
    u.ws?.close();
  }
  console.log(JSON.stringify({ users: USERS, duration: DURATION, registered: stats.registered, sockets: stats.sockets }));
  process.exit(0);
}

// 4. traffic
const intervalMs = 60000 / RATE;
const end = performance.now() + DURATION * 1000;
let seq = 0;
const senders = pairs
  .flatMap((p) => [
    { from: p.a, to: p.b, p },
    { from: p.b, to: p.a, p },
  ])
  .map(async ({ from, to, p }) => {
    await sleep(Math.random() * intervalMs);
    while (performance.now() < end) {
      const n = ++seq;
      const ciphertext = Buffer.concat([Buffer.from(`${n}:`), randomBytes(120)]).toString('base64');
      const t0 = performance.now();
      const key = `${p.conversationId}:${to.deviceId}`;
      if (!pendingHints.has(key)) pendingHints.set(key, []);
      pendingHints.get(key).push(t0);
      stats.hints.expected++;
      try {
        const r = await call(from, 'e2ee.sendMessage', {
          conversationId: p.conversationId,
          ciphertext,
          messageType: 'application',
          mlsGeneration: 1,
        });
        stats.sends.ok++;
        stats.sends.latencies.push(performance.now() - t0);
        // Ordering is checked per sender: each sender awaits its own sends
        // in sequence, while the two members' sends may legitimately
        // interleave in any order (the server orders by insert time).
        p.expected.set(r.messageId, { n, sender: from.deviceId });
      } catch (err) {
        if (err.name === 'AbortError') stats.sends.timeouts++;
        else {
          stats.sends.failed++;
          countError(stats.sends.errors, err);
        }
      }
      await sleep(intervalMs);
    }
  });
const t0traffic = performance.now();
await Promise.all(senders);
stats.trafficSeconds = Math.round(performance.now() - t0traffic) / 1000;
await sleep(2000);
stopped = true;

// 5. verify: each receiver reads its whole conversation once
for (const p of pairs) {
  for (const reader of [p.a, p.b]) {
    const rows = await fetchAndCheck(reader, p);
    if (!rows) continue;
    const ids = rows.filter((r) => r.messageType === 'application').map((r) => r.id);
    stats.fetch.rows += ids.length;
    const seen = new Set();
    const lastBySender = new Map();
    for (const id of ids) {
      if (seen.has(id)) stats.fetch.duplicates++;
      seen.add(id);
      const sent = p.expected.get(id);
      if (sent) {
        const last = lastBySender.get(sent.sender) ?? -1;
        if (sent.n < last) stats.fetch.outOfOrder++;
        lastBySender.set(sent.sender, Math.max(last, sent.n));
      }
    }
    for (const id of p.expected.keys()) if (!seen.has(id)) stats.fetch.missing++;
  }
}
for (const u of users) {
  clearInterval(u.ping);
  try {
    u.ws?.close();
  } catch {}
}

const summarize = (o) => ({ ...o, p50: pct(o.latencies, 50), p95: pct(o.latencies, 95), p99: pct(o.latencies, 99), max: pct(o.latencies, 100), latencies: undefined });
const out = { ...stats, sends: summarize(stats.sends), hints: summarize(stats.hints), fetch: summarize(stats.fetch) };
out.sends.perSecond = Math.round((stats.sends.ok / Math.max(1, stats.trafficSeconds)) * 10) / 10;
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
const file = new URL(`./results/${out.startedAt.replace(/[:.]/g, '-')}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
