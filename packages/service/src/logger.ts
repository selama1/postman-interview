import type { LoggerOptions } from 'pino';
import type { Config } from './config.js';

/**
 * Pino options shared by Fastify (request logger) and standalone scripts.
 * - json in containers / CI (machine-greppable), pretty for humans.
 * - every request log line carries reqId (also echoed as the x-request-id response header),
 *   so `grep <reqId>` reconstructs one request across app + SQL logs.
 * - secrets are redacted at the logger, not at call sites.
 */
export function loggerOptions(config: Pick<Config, 'LOG_LEVEL' | 'LOG_FORMAT' | 'NODE_ENV'>): LoggerOptions {
  const format = config.LOG_FORMAT ?? (config.NODE_ENV === 'production' ? 'json' : 'pretty');
  return {
    level: config.LOG_LEVEL,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]', '*.password', '*.token'],
      censor: '[redacted]',
    },
    ...(format === 'pretty'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname', singleLine: false },
          },
        }
      : {}),
  };
}
