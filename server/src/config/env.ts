import 'dotenv/config';
import { z } from 'zod';

import { isHopCountTrustProxy, resolveTrustProxy } from './trustProxy.js';

/**
 * Every environment variable the server depends on, validated once at
 * startup. Fail fast and loud rather than run with an undefined secret —
 * `process.exit(1)` here is deliberate, not an oversight.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid postgres:// connection string'),
  // Connections this instance keeps to Postgres. The ceiling on statements
  // per second is DB_POOL_MAX / round-trip time: with the database ~150 ms
  // away (Railway us-west → Supabase eu-west-1) 10 connections serve about
  // 65 statements/s, after which requests queue inside the process (see
  // docs/ENGINEERING_CHECKLIST.md, "Scale readiness"). Must stay below the
  // database's own connection limit, summed over every instance.
  DB_POOL_MAX: z.coerce.number().int().min(1).max(500).default(10),
  // Load shedding (lib/overload.ts): while more than this many requests
  // wait for a pooled connection, polling procedures are answered with
  // TOO_MANY_REQUESTS + Retry-After instead of queueing. Default: twice the
  // pool (every waiting request is already two round trips behind). 0
  // disables shedding.
  DB_SHED_WAITING: z.coerce.number().int().min(0).max(100000).optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  CORS_ORIGIN: z.string().min(1).default('*'),
  ARGON2_PEPPER: z
    .string()
    .min(32, 'ARGON2_PEPPER must be at least 32 characters — generate with `openssl rand -base64 32`'),
  ACCESS_TOKEN_SECRET: z
    .string()
    .min(32, 'ACCESS_TOKEN_SECRET must be at least 32 characters — generate with `openssl rand -base64 32`'),
  // Local-disk directory for opaque voice-message ciphertext blobs (see
  // lib/mediaStorage.ts). Not a cloud/S3 path on purpose — there is no
  // object-storage backend configured anywhere else in this project, and
  // these blobs are already size-bounded, encrypted, opaque bytes, so a
  // plain directory is the smallest correct storage for this phase.
  MEDIA_STORAGE_DIR: z.string().min(1).default('./data/media'),
  // Which upstream proxy addresses may be believed when deriving the
  // real client IP from X-Forwarded-For. See `resolveTrustProxy` below
  // for the accepted values and why this is expressed as a trusted-CIDR
  // list rather than a hop count.
  TRUST_PROXY: z.string().optional(),
  // Firebase service account key (the whole JSON file as one string) used
  // to send push notifications through FCM. Optional: without it the server
  // still stores device push tokens but delivers no pushes — see
  // lib/pushDelivery.ts and the `notifications.status` procedure.
  FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),
  // Cloudflare Realtime TURN key (dashboard → Realtime → TURN Server). The
  // API token mints short-lived relay credentials for calls and never leaves
  // the server. Optional: without both, calls use direct connections only
  // (STUN), which can't connect on some networks — see lib/iceServers.ts.
  TURN_KEY_ID: z.string().min(1).optional(),
  TURN_API_TOKEN: z.string().min(1).optional(),
  // Development only (ignored in production): a JSON array of ICE servers
  // returned instead, e.g. a TURN server on the dev machine for emulators.
  DEV_ICE_SERVERS_JSON: z.string().optional(),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('✖ Invalid environment configuration:');
    for (const issue of parsed.error.issues) {
      // eslint-disable-next-line no-console
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
export const isProduction = env.NODE_ENV === 'production';
export type Env = typeof env;

/**
 * Which upstream hops may be believed when deriving the real client IP.
 * See config/trustProxy.ts for why this is a trusted-address list
 * rather than a hop count, and why that choice is spoof-resistant.
 */
export const trustProxyOption = resolveTrustProxy(env.TRUST_PROXY, isProduction);

/**
 * True when every request will resolve to the same `req.ip` regardless
 * of who sent it, which silently collapses every per-IP rate limit into
 * one globally shared bucket. Surfaced at startup rather than left to be
 * discovered in production.
 */
export const trustProxyDisabledBehindProxy = isProduction && trustProxyOption === false;

/** Pool wait-queue depth above which polling procedures are shed (lib/overload.ts); 0 = never. */
export const shedWaitingThreshold = env.DB_SHED_WAITING ?? env.DB_POOL_MAX * 2;

/** TRUST_PROXY was set to a hop count, which is refused (see trustProxy.ts) — reported at startup. */
export const trustProxyHopCountIgnored = isHopCountTrustProxy(env.TRUST_PROXY);
