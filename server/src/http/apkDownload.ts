import { createReadStream } from 'node:fs';

import type { FastifyInstance } from 'fastify';

import { checkRateLimit, RateLimitExceededError } from '../lib/rateLimit.js';
import { getReleaseApk, releaseApkFileName, type ReleaseApk } from '../lib/releaseApk.js';

export interface ApkDownloadOptions {
  /** Defaults to the verified release APK from lib/releaseApk.ts; overridable for tests. */
  getApk?: () => Promise<ReleaseApk>;
  /** Defaults to the current manifest's `SecureMessenger-v<versionName>.apk`. */
  fileName?: string;
  /** Start fetching/verifying the APK as soon as the server is ready, so the first download doesn't wait on it. */
  prewarm?: boolean;
}

export type ByteRange = { start: number; end: number };

/**
 * Parses a single `Range: bytes=...` header against a file of `size`
 * bytes. Returns `null` when the whole file should be sent instead
 * (absent, malformed, or multi-range — all of which RFC 9110 allows a
 * server to answer with a plain 200), and `'unsatisfiable'` for a
 * well-formed range that lies outside the file (416).
 */
export function parseByteRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startText = '', endText = ''] = match;
  if (startText === '' && endText === '') return null;

  if (startText === '') {
    const suffixLength = Number(endText);
    if (suffixLength === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(startText);
  const end = endText === '' ? size - 1 : Math.min(Number(endText), size - 1);
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/**
 * Direct APK download for sideloading SecureMessenger from a browser.
 * Serves the exact release APK bytes (see lib/releaseApk.ts) with a plain
 * 200 — no redirect to GitHub's signed asset host — plus the headers
 * Android download managers rely on: an explicit APK content type, an
 * attachment filename, Content-Length, and single-range resume support.
 *
 * Public and unauthenticated like /update-manifest: a user installing the
 * app has no account session yet, and the APK is already public on
 * GitHub Releases. The in-app updater keeps using the manifest's apkUrl.
 */
export async function apkDownloadRoutes(app: FastifyInstance, opts: ApkDownloadOptions) {
  const getApk = opts.getApk ?? getReleaseApk;
  const fileName = opts.fileName ?? releaseApkFileName();

  if (opts.prewarm) {
    app.addHook('onReady', async () => {
      getApk()
        .then((apk) => app.log.info({ fileName, size: apk.size, sha256: apk.sha256 }, 'release APK verified and ready to serve'))
        .catch((err: unknown) => app.log.error({ err }, 'release APK prewarm failed; will retry on first download'));
    });
  }

  // HEAD is declared explicitly rather than left to Fastify's auto-generated
  // HEAD route: that route's onSend hook forces `content-length: 0` for an
  // empty body, which would hide the APK's real size from download managers.
  app.route<{ Params: { fileName: string } }>({
    method: ['GET', 'HEAD'],
    url: '/download/:fileName',
    handler: async (req, reply) => {
      if (req.params.fileName !== fileName) {
        return reply.status(404).send({ error: 'Not found' });
      }

      try {
        checkRateLimit(`download:apk:ip:${req.ip}`, 30, 10 * 60 * 1000);
      } catch (err) {
        if (err instanceof RateLimitExceededError) {
          reply.header('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
          return reply.status(429).send({ error: 'Too many download attempts. Please try again shortly.' });
        }
        throw err;
      }

      let apk: ReleaseApk;
      try {
        apk = await getApk();
      } catch (err) {
        req.log.error({ err }, 'release APK unavailable for download');
        reply.header('Retry-After', '30');
        return reply.status(503).send({ error: 'The download is temporarily unavailable. Please try again shortly.' });
      }

      const etag = `"${apk.sha256}"`;
      reply
        .header('Content-Type', 'application/vnd.android.package-archive')
        .header('Content-Disposition', `attachment; filename="${fileName}"`)
        .header('Accept-Ranges', 'bytes')
        .header('ETag', etag)
        // The URL names one exact version and its bytes never change.
        .header('Cache-Control', 'public, max-age=31536000, immutable');

      const ifRange = req.headers['if-range'];
      const range = ifRange && ifRange !== etag ? null : parseByteRange(req.headers.range, apk.size);

      if (range === 'unsatisfiable') {
        reply.header('Content-Range', `bytes */${apk.size}`);
        return reply.status(416).send();
      }

      const { start, end } = range ?? { start: 0, end: apk.size - 1 };
      if (range) {
        reply.status(206).header('Content-Range', `bytes ${start}-${end}/${apk.size}`);
      }
      reply.header('Content-Length', String(end - start + 1));

      if (req.method === 'HEAD') {
        return reply.send();
      }
      return reply.send(createReadStream(apk.path, { start, end }));
    },
  });
}
