import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createDbFromConfig } from '../../src/db/kysely.js';
import { buildApp } from '../../src/http/app.js';
import type { FixtureRegistry } from '../../src/db/template.js';
import { TestSessionManager } from '../../src/testing/sessions.js';
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
  /** Start every test from this named fixture instead of an empty DB (both targets). */
  fixture?: string;
  /** Fixture registry override (default src/testing/fixtures.ts) — integration target only. */
  fixtures?: FixtureRegistry;
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
  const db = await freshDb({ fixture: opts.fixture, fixtures: opts.fixtures });
  try {
    await opts.setup?.(db);
    const config = loadConfig(
      { ...process.env, NODE_ENV: 'test', LOG_LEVEL: testEnv.logLevel, LOG_FORMAT: 'pretty' },
      { DATABASE_URL: db.url, DB_POOL_MAX: '5', LOG_SQL: String(testEnv.logSql), ...opts.env },
    );
    const logger = testEnv.logLevel === 'silent' ? undefined : pino({ level: testEnv.logLevel }).child({ component: 'sql' });
    const conn = createDbFromConfig(config, logger); // same wiring as src/main.ts
    let testSessions: TestSessionManager | undefined;
    if (config.TEST_SESSIONS_ENABLED) {
      testSessions = new TestSessionManager({
        adminUrl: db.url,
        ttlMs: config.TEST_SESSION_TTL_MIN * 60_000,
        maxSessions: config.TEST_SESSIONS_MAX,
        ...(opts.fixtures ? { fixtures: opts.fixtures } : {}),
      });
      await testSessions.start();
    }
    const app = await buildApp({
      config,
      ...conn,
      ...(testSessions ? { testSessions } : {}),
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
  /** true when every test owns its database: integration (fresh DB) and e2e with test sessions. */
  isolated: boolean;
  baseUrl: string;
  client: TestClient;
  /** e2e: the test's x-test-session id (its isolated DB on the stack). */
  testSession: string | undefined;
  /** Integration only: the test's own fresh database (direct SQL access). */
  db: FreshDb | undefined;
  server: TestServer | undefined;
}

/**
 * Vitest hook helper — every test starts on an EMPTY, migrated database on BOTH targets:
 *  - integration: a fresh DB + in-process server per test (default) or per file;
 *  - e2e (TEST_TARGET=e2e): the compose stack over HTTP, with a fresh API test session
 *    (POST /_test/sessions -> x-test-session header on every request) per test or per file.
 *    Pass `session: false` to hit the stack's real (shared) database instead.
 *
 *   const t = useTarget();
 *   it('...', async () => { const res = await t.client.get('/health'); ... });
 */
export function useTarget(opts: TestServerOptions & { fresh?: 'each' | 'file'; session?: boolean } = {}): Target {
  const t = { kind: testEnv.target, isolated: testEnv.target === 'integration', testSession: undefined } as Target;
  const each = opts.fresh !== 'file';
  if (testEnv.target === 'e2e') {
    t.baseUrl = testEnv.e2eBaseUrl;
    t.client = new TestClient(testEnv.e2eBaseUrl);
    t.db = undefined;
    t.server = undefined;
    if (opts.session === false) return t;
    if (opts.setup || opts.plugins) {
      throw new Error('useTarget: fixture setup/plugins only exist in-process; put this test in test/integration/, not test/scenarios/.');
    }
    const open = async () => Object.assign(t, await openTestSession(testEnv.e2eBaseUrl, opts.fixture));
    const close = async () => {
      if (t.testSession) await new TestClient(t.baseUrl).delete(`/_test/sessions/${t.testSession}`);
    };
    (each ? beforeEach : beforeAll)(open);
    (each ? afterEach : afterAll)(close);
    return t;
  }
  const start = async () => {
    const s = await startTestServer(opts);
    Object.assign(t, { server: s, db: s.db, baseUrl: s.baseUrl, client: s.client });
  };
  const stop = async () => t.server?.close();
  (each ? beforeEach : beforeAll)(start);
  (each ? afterEach : afterAll)(stop);
  return t;
}

/** Create an API test session (optionally from a named fixture) on a running server; returns a client bound to it. */
export async function openTestSession(baseUrl: string, fixture?: string) {
  const res = await new TestClient(baseUrl).post<{ id: string }>('/_test/sessions', fixture ? { fixture } : undefined);
  if (res.status !== 201) {
    throw new Error(
      `Could not create a test session on ${baseUrl} (HTTP ${res.status}: ${JSON.stringify(res.body)}).
` +
        'Fix: the stack must run with TEST_SESSIONS_ENABLED=true (the compose default), then `pnpm up`.',
    );
  }
  const id = res.body.id;
  return { testSession: id, isolated: true, client: new TestClient(baseUrl, { headers: { 'x-test-session': id } }) };
}
