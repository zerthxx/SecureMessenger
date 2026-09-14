import type { FastifyBaseLogger } from 'fastify';
import type { LoggerOptions } from 'pino';

import { env, isProduction } from '../config/env.js';

/**
 * Fields that must never reach a log line, however deeply nested. Extend
 * this list the moment a new route accepts a new kind of secret — it is
 * the single place that enforces "never log passwords, tokens, recovery
 * codes, or message plaintext."
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.recoveryCode',
  '*.recoveryCodeHash',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.ciphertext',
  '*.plaintext',
  // Calls: TURN relay credentials and sealed call signaling.
  '*.credential',
  '*.apiToken',
  '*.payload',
];

export const loggerOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
};

export type Logger = FastifyBaseLogger;
