import { Kysely, PostgresDialect, type LogEvent } from 'kysely';
import pg from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Database } from './schema.js';

// pg returns int8 (bigint, count(*)) as string by default. count(*) as string is a classic
// footgun; parse int8 to number (safe below 2^53 — fine for counts/ids here).
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));
// date (no time) as 'YYYY-MM-DD': pg's default is a JS Date at local midnight, which shifts the day
// across timezones. The API contract for date columns is the plain string.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
// numeric stays a string on purpose (money/precision). Parse at the edge if you need math.

export interface DbOptions {
  url: string;
  poolMax?: number;
  statementTimeoutMs?: number;
  logger?: Logger;
  logSql?: boolean;
  slowQueryMs?: number;
  applicationName?: string;
}

export type Db = Kysely<Database>;

export function createDb(opts: DbOptions): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString: opts.url,
    max: opts.poolMax ?? 10,
    application_name: opts.applicationName ?? 'planet-express-service',
    ...(opts.statementTimeoutMs ? { statement_timeout: opts.statementTimeoutMs } : {}),
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', (err) => opts.logger?.error({ err }, 'idle pg client error'));

  const log = opts.logger;
  const slow = opts.slowQueryMs ?? 250;
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    log: log
      ? (event: LogEvent) => {
          const ms = Math.round(event.queryDurationMillis * 10) / 10;
          const sql = event.query.sql;
          if (event.level === 'error') {
            log.error({ err: event.error, sql, params: event.query.parameters, ms }, 'sql error');
          } else if (ms >= slow) {
            log.warn({ sql, params: event.query.parameters, ms }, 'slow query');
          } else if (opts.logSql) {
            log.debug({ sql, params: event.query.parameters, ms }, 'sql');
          }
        }
      : undefined,
  });
  return { db, pool };
}

/**
 * THE way to build the app's DB handle from config — used by main.ts AND the test harness, so
 * tests exercise exactly the production pool settings (timeouts, pool size, logging).
 */
export function createDbFromConfig(config: Config, logger?: Logger) {
  return createDb({
    url: config.DATABASE_URL,
    poolMax: config.DB_POOL_MAX,
    statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
    ...(logger ? { logger } : {}),
    logSql: config.LOG_SQL,
    slowQueryMs: config.SLOW_QUERY_MS,
  });
}
