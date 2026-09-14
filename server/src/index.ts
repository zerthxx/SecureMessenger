import { buildApp } from './app.js';
import { env } from './config/env.js';
import { pool } from './db/client.js';
import { sessions } from './realtime/instance.js';

const app = buildApp();

const SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let sessionSweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Enforces each account's "automatically terminate old sessions" setting for
 * devices that never come back. A device that does return is checked on its
 * next request or token refresh anyway (lib/sessions.ts, auth.refresh).
 */
async function sweepInactiveSessions() {
  try {
    const terminated = await sessions.sweepInactive();
    if (terminated > 0) app.log.info({ terminated }, 'terminated inactive sessions');
  } catch (err) {
    app.log.warn({ err }, 'inactive session sweep failed');
  }
}

async function start() {
  try {
    await app.listen({ host: env.HOST, port: env.PORT });
    app.log.info({ env: env.NODE_ENV }, `server listening on ${env.HOST}:${env.PORT}`);
    void sweepInactiveSessions();
    sessionSweepTimer = setInterval(() => void sweepInactiveSessions(), SESSION_SWEEP_INTERVAL_MS);
    sessionSweepTimer.unref();
  } catch (err) {
    app.log.error({ err }, 'failed to start server');
    process.exit(1);
  }
}

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  if (sessionSweepTimer) clearInterval(sessionSweepTimer);
  await app.close();
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

void start();
