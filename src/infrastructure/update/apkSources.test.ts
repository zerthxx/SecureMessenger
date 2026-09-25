import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apkDownloadSources } from './apkSources.ts';

const API = 'https://securemessenger-production-e903.up.railway.app';
const GITHUB = 'https://github.com/zerthxx/SecureMessenger/releases/download/v0.9.0/app-release.apk';

test('GitHub first, then the same release from our own server', () => {
  assert.deepEqual(apkDownloadSources({ apkUrl: GITHUB, versionName: '0.9.0' }, API), [
    GITHUB,
    `${API}/download/SecureMessenger-v0.9.0.apk`,
  ]);
});

test('only HTTPS sources, and no path tricks through the version name', () => {
  assert.deepEqual(apkDownloadSources({ apkUrl: 'http://example.com/x.apk', versionName: '0.9.0' }, API), [
    `${API}/download/SecureMessenger-v0.9.0.apk`,
  ]);
  assert.deepEqual(apkDownloadSources({ apkUrl: GITHUB, versionName: '../../etc' }, API), [GITHUB]);
  assert.deepEqual(apkDownloadSources({ apkUrl: GITHUB, versionName: '0.9.0' }, 'http://10.0.2.2:4000'), [GITHUB]);
  assert.deepEqual(apkDownloadSources({ apkUrl: '', versionName: '' }, API), []);
});
