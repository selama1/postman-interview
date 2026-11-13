import pino from 'pino';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createDbFromConfig } from './db/kysely.js';
import { migrateToLatest } from './db/migrate.js';
import { buildApp } from './http/app.js';
import { loggerOptions } from './logger.js';

async function main() {
  const config = loadConfig();
  const app = await buildApp({ config, ...connect(config) });
  const log = app.log;

  if (config.MIGRATE_ON_START) {
    const r = await migrateToLatest(app.db);
    const applied = (r.results ?? []).map((m) => m.migrationName);
    log.info({ applied }, applied.length ? `applied ${applied.length} migration(s)` : 'migrations up to date');
  }

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
