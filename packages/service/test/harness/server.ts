import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createDbFromConfig } from '../../src/db/kysely.js';
import { buildApp } from '../../src/http/app.js';
import { TestClient } from './client.js';
import { testEnv } from './env.js';
import { freshDb, type FreshDb } from './fresh-db.js';

export interface TestServerOptions {
  /** Extra route plugins (fixture resources) registered after the real routes. */
  plugins?: Array<{ plugin: FastifyPluginAsync; prefix?: string }>;
  /** Runs against the fresh DB before the app starts (fixture DDL, seed rows). */
  setup?: (db: FreshDb) => Promise<void>;
  /** Config overrides (string values, as env vars would be). */
  env?: Record<string, string>;
}

export interface TestServer {
  baseUrl: string;
  app: FastifyInstance;
  db: FreshDb;
  client: TestClient;
  close: () => Promise<void>;
}

/**
 * Fresh empty DB + the REAL app (same buildApp as production) listening on a random port.
 * Tests talk to it over real HTTP (not inject), so serialization, headers, error handling and
 * the pg pool behave exactly as in the container.
 */
export async function startTestServer(opts: TestServerOptions = {}): Promise<TestServer> {
  const db = await freshDb();
  try {
    await opts.setup?.(db);
    const config = loadConfig(
      { ...process.env, NODE_ENV: 'test', LOG_LEVEL: testEnv.logLevel, LOG_FORMAT: 'pretty' },
      { DATABASE_URL: db.url, DB_POOL_MAX: '5', LOG_SQL: String(testEnv.logSql), ...opts.env },
    );
    const logger = testEnv.logLevel === 'silent' ? undefined : pino({ level: testEnv.logLevel }).child({ component: 'sql' });
    const conn = createDbFromConfig(config, logger); // same wiring as src/main.ts
    const app = await buildApp({
      config,
      ...conn,
      logger: testEnv.logLevel === 'silent' ? false : { level: testEnv.logLevel },
      ...(opts.plugins ? { plugins: opts.plugins } : {}),
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;
    return {
      baseUrl,
      app,
      db,
      client: new TestClient(baseUrl),
      close: async () => {
        await app.close();
        await conn.db.destroy();
        await db.drop();
      },
    };
  } catch (err) {
    await db.drop();
    throw err;
  }
}

export interface Target {
  kind: 'integration' | 'e2e';
  /** true when every test owns its database (integration); false on the shared e2e stack. */
  isolated: boolean;
  baseUrl: string;
  client: TestClient;
  /** Integration only: the test's own fresh database. */
  db: FreshDb | undefined;
  server: TestServer | undefined;
}

/**
 * Vitest hook helper. Integration: a fresh DB + server per test (default) or per file.
 * E2E (TEST_TARGET=e2e): a client for E2E_BASE_URL; data is shared, so create uniquely
 * named data (`uniq()`) and never assume empty tables.
 *
 *   const t = useTarget();
 *   it('...', async () => { const res = await t.client.get('/health'); ... });
 */
export function useTarget(opts: TestServerOptions & { fresh?: 'each' | 'file' } = {}): Target {
  const t = { kind: testEnv.target, isolated: testEnv.target === 'integration' } as Target;
  if (testEnv.target === 'e2e') {
    t.baseUrl = testEnv.e2eBaseUrl;
    t.client = new TestClient(testEnv.e2eBaseUrl);
    t.db = undefined;
    t.server = undefined;
    return t;
  }
  const start = async () => {
    const s = await startTestServer(opts);
    Object.assign(t, { server: s, db: s.db, baseUrl: s.baseUrl, client: s.client });
  };
  const stop = async () => t.server?.close();
  if (opts.fresh === 'file') {
    beforeAll(start);
    afterAll(stop);
  } else {
    beforeEach(start);
    afterEach(stop);
  }
  return t;
}
