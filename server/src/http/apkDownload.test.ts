import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';

import fastify from 'fastify';

import { __resetRateLimitsForTest } from '../lib/rateLimit.js';
import type { ReleaseApk } from '../lib/releaseApk.js';
import { apkDownloadRoutes, parseByteRange } from './apkDownload.js';

const FILE_NAME = 'SecureMessenger-v9.9.9.apk';
const DOWNLOAD_URL = `/download/${FILE_NAME}`;

describe('parseByteRange', () => {
  test('sends the whole file for absent, malformed, or multi-range headers', () => {
    assert.equal(parseByteRange(undefined, 100), null);
    assert.equal(parseByteRange('items=0-1', 100), null);
    assert.equal(parseByteRange('bytes=0-1,5-6', 100), null);
    assert.equal(parseByteRange('bytes=-', 100), null);
  });

  test('parses closed, open-ended, and suffix ranges', () => {
    assert.deepEqual(parseByteRange('bytes=0-9', 100), { start: 0, end: 9 });
    assert.deepEqual(parseByteRange('bytes=90-', 100), { start: 90, end: 99 });
    assert.deepEqual(parseByteRange('bytes=-10', 100), { start: 90, end: 99 });
    assert.deepEqual(parseByteRange('bytes=-500', 100), { start: 0, end: 99 });
    assert.deepEqual(parseByteRange('bytes=50-500', 100), { start: 50, end: 99 });
  });

  test('flags ranges outside the file as unsatisfiable', () => {
    assert.equal(parseByteRange('bytes=100-', 100), 'unsatisfiable');
    assert.equal(parseByteRange('bytes=9-3', 100), 'unsatisfiable');
    assert.equal(parseByteRange('bytes=-0', 100), 'unsatisfiable');
  });
});

describe('APK download route', () => {
  let dir: string;
  let apk: ReleaseApk;
  let bytes: Buffer;

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'apk-download-test-'));
    bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    const apkPath = path.join(dir, 'release.apk');
    await writeFile(apkPath, bytes);
    apk = { path: apkPath, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    __resetRateLimitsForTest();
  });

  function buildTestApp(getApk: () => Promise<ReleaseApk> = async () => apk) {
    const app = fastify();
    app.register(apkDownloadRoutes, { getApk, fileName: FILE_NAME });
    return app;
  }

  test('GET serves the exact bytes with download headers and no redirect', async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: 'GET', url: DOWNLOAD_URL });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/vnd.android.package-archive');
    assert.equal(res.headers['content-disposition'], `attachment; filename="${FILE_NAME}"`);
    assert.equal(res.headers['content-length'], String(bytes.length));
    assert.equal(res.headers['accept-ranges'], 'bytes');
    assert.equal(res.headers.etag, `"${apk.sha256}"`);
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(res.headers.location, undefined);
    assert.equal(createHash('sha256').update(res.rawPayload).digest('hex'), apk.sha256);
    await app.close();
  });

  test('HEAD returns the same headers without a body', async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: 'HEAD', url: DOWNLOAD_URL });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/vnd.android.package-archive');
    assert.equal(res.headers['content-length'], String(bytes.length));
    assert.equal(res.rawPayload.length, 0);
    await app.close();
  });

  test('a byte range returns 206 with only the requested bytes', async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: 'GET', url: DOWNLOAD_URL, headers: { range: 'bytes=100-199' } });
    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['content-range'], `bytes 100-199/${bytes.length}`);
    assert.equal(res.headers['content-length'], '100');
    assert.deepEqual(res.rawPayload, bytes.subarray(100, 200));
    await app.close();
  });

  test('an out-of-bounds range returns 416', async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: 'GET', url: DOWNLOAD_URL, headers: { range: `bytes=${bytes.length}-` } });
    assert.equal(res.statusCode, 416);
    assert.equal(res.headers['content-range'], `bytes */${bytes.length}`);
    await app.close();
  });

  test('a stale If-Range falls back to the full file', async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: 'GET', url: DOWNLOAD_URL, headers: { range: 'bytes=0-9', 'if-range': '"other"' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.rawPayload.length, bytes.length);
    await app.close();
  });

  test('any other filename is 404 and never touches the APK', async () => {
    let calls = 0;
    const app = buildTestApp(async () => {
      calls += 1;
      return apk;
    });
    const res = await app.inject({ method: 'GET', url: '/download/SecureMessenger-v0.0.1.apk' });
    assert.equal(res.statusCode, 404);
    assert.equal(calls, 0);
    await app.close();
  });

  test('an unavailable APK is a retryable 503, not a partial download', async () => {
    const app = buildTestApp(async () => {
      throw new Error('SHA-256 mismatch');
    });
    const res = await app.inject({ method: 'GET', url: DOWNLOAD_URL });
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['retry-after'], '30');
    await app.close();
  });
});
