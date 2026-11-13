import pino from 'pino';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createDbFromConfig } from './db/kysely.js';
import { migrateToLatest } from './db/migrate.js';
import { buildApp } from './http/app.js';
import { loggerOptions } from './logger.js';
import { TestSessionManager } from './testing/sessions.js';

async function main() {
  const config = loadConfig();
  const conn = connect(config);
  const baseLog = pino(loggerOptions(config));

  if (config.MIGRATE_ON_START) {
    const r = await migrateToLatest(conn.db);
    const applied = (r.results ?? []).map((m) => m.migrationName);
    baseLog.info({ applied }, applied.length ? `applied ${applied.length} migration(s)` : 'migrations up to date');
  }

  let testSessions: TestSessionManager | undefined;
  if (config.TEST_SESSIONS_ENABLED) {
    testSessions = new TestSessionManager({
      adminUrl: config.DATABASE_URL,
      ttlMs: config.TEST_SESSION_TTL_MIN * 60_000,
      maxSessions: config.TEST_SESSIONS_MAX,
      statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
      logger: baseLog.child({ component: 'test-sessions' }),
    });
    await testSessions.start();
    baseLog.warn('API test mode ENABLED (x-test-session). Do not enable on deployments holding real data.');
  }

  const app = await buildApp({ config, ...conn, ...(testSessions ? { testSessions } : {}) });
  const log = app.log;

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000).unref();
    try {
      await app.close(); // stops accepting, drains in-flight requests
      await app.db.destroy();
      clearTimeout(force);
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.HOST, port: config.PORT });
}

function connect(config: Config) {
  return createDbFromConfig(config, pino(loggerOptions(config)).child({ component: 'sql' }));
}

main().catch((err: unknown) => {
  // ConfigError already carries reason + fix; anything else gets a stack.
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
